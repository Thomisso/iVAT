import { describe, expect, it } from "vitest";
import type { AiInput } from "@/application/ai-provider";
import { listAuditEvents } from "@/application/audit";
import { disableAiProcessing, enableAiProcessing, getCompany } from "@/application/companies";
import { listDocuments, listExtractionVersions, readDocumentRows, reprocessDocument } from "@/application/documents";
import type { Direction, ExtractionPayload } from "@/application/extraction-payload";
import { getSourceFile, retrySplit, uploadSourceFile } from "@/application/source-files";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { signedUpUser } from "./support/clients";
import { fixtureFile, heicFixture, workbookFile } from "./support/files";
import { administratorWithCompany } from "./support/fixtures";
import { testWorker } from "./support/worker";

const INVOICE_1: ExtractionPayload = { ...SAMPLE_EXTRACTION, documentNumber: "FV-1" };
const INVOICE_2: ExtractionPayload = { ...SAMPLE_EXTRACTION, documentNumber: "FV-2" };

/** An Administrator whose Company has AI processing enabled for the worker's provider. */
async function companyWithAiProcessing(worker: ReturnType<typeof testWorker>) {
  const admin = await administratorWithCompany();
  const enabled = await enableAiProcessing(admin.client, worker.jobs, {
    companyId: admin.companyId,
    provider: worker.ai,
  });
  if (!enabled.ok) throw new Error(enabled.error);
  return admin;
}

async function upload(
  { client, companyId }: { client: Awaited<ReturnType<typeof administratorWithCompany>>["client"]; companyId: string },
  worker: ReturnType<typeof testWorker>,
  fixture = "two-invoices.pdf",
  preselectedDirection: Direction | null = "incoming",
) {
  const result = await uploadSourceFile(client, worker.jobs, {
    companyId,
    fileName: fixture,
    bytes: fixtureFile(fixture),
    preselectedDirection: preselectedDirection ?? undefined,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value.id;
}

describe("processing a Source File", () => {
  it("Splits a multi-Document PDF and Extracts each Document for review, in the background", async () => {
    const extracted: AiInput[] = [];
    const worker = testWorker(
      fakeAiProvider({
        extract: (input) => {
          extracted.push(input);
          return extracted.length === 1 ? INVOICE_1 : INVOICE_2;
        },
      }),
    );
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker);

    expect((await getSourceFile(client, companyId, sourceFileId))?.status).toBe("uploaded");
    expect(await listDocuments(client, companyId, sourceFileId)).toEqual([]);

    expect(await worker.runJobs()).toEqual([]);

    expect((await getSourceFile(client, companyId, sourceFileId))?.status).toBe("split");
    const documents = await listDocuments(client, companyId, sourceFileId);
    expect(documents).toEqual([
      {
        id: expect.any(String), companyId, sourceFileId,
        firstPage: 1, lastPage: 1, status: "needs_review",
        createdAt: expect.any(String), receiptDate: expect.any(String),
        claimedReportingPeriod: null,
      },
      {
        id: expect.any(String), companyId, sourceFileId,
        firstPage: 2, lastPage: 2, status: "needs_review",
        createdAt: expect.any(String), receiptDate: expect.any(String),
        claimedReportingPeriod: null,
      },
    ]);
    expect(extracted.map((input) => [input.format, input.pageCount])).toEqual([
      ["pdf", 1],
      ["pdf", 1],
    ]);
    expect(await listExtractionVersions(client, companyId, documents[0].id)).toEqual([
      {
        id: expect.any(String),
        documentId: documents[0].id,
        version: 1,
        author: { kind: "ai" },
        payload: INVOICE_1,
        findings: [],
        createdAt: expect.any(String),
      },
    ]);
    expect((await listExtractionVersions(client, companyId, documents[1].id)).map((v) => v.payload)).toEqual([INVOICE_2]);
  });
});

describe("VAT payer registry checks", () => {
  it("stores unreliable-payer and unpublished-account warnings on the Extraction Version", async () => {
    const worker = testWorker(fakeAiProvider(), {
      check: async () => ({
        outcome: "checked",
        unreliable: true,
        publishedAccounts: ["19-2000145399/0800"],
      }),
    });
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload(
      { client, companyId },
      worker,
      "receipt.png",
    );

    expect(await worker.runJobs()).toEqual([]);

    const [document] = await listDocuments(client, companyId, sourceFileId);
    expect(document.status).toBe("needs_review");
    const [version] = await listExtractionVersions(
      client,
      companyId,
      document.id,
    );
    expect(version.findings).toEqual([
      {
        field: "supplier.vatId",
        severity: "warning",
        code: "unreliable_vat_payer",
      },
      {
        field: "payment.bankAccount",
        severity: "warning",
        code: "unpublished_bank_account",
      },
    ]);
  });

  it("finishes processing and records that an unavailable registry check was not performed", async () => {
    const worker = testWorker(fakeAiProvider(), {
      check: async () => ({ outcome: "unavailable" }),
    });
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload(
      { client, companyId },
      worker,
      "receipt.png",
    );

    expect(await worker.runJobs()).toEqual([]);

    const [document] = await listDocuments(client, companyId, sourceFileId);
    expect(document.status).toBe("needs_review");
    const [version] = await listExtractionVersions(
      client,
      companyId,
      document.id,
    );
    expect(version.findings).toContainEqual({
      field: "supplier.vatId",
      severity: "warning",
      code: "vat_registry_check_not_performed",
    });
  });
});

describe("automatic Direction detection", () => {
  it.each([
    ["supplier", "outgoing"],
    ["customer", "incoming"],
  ] as const)("uses a Company identity match on the %s", async (party, direction) => {
    const companyIdentity = { ico: "", vatId: "" };
    const worker = testWorker(
      fakeAiProvider({
        extract: () => ({
          ...SAMPLE_EXTRACTION,
          direction: direction === "incoming" ? "outgoing" : "incoming",
          [party]: {
            ...SAMPLE_EXTRACTION[party],
            ico: companyIdentity.ico,
            vatId: companyIdentity.vatId,
          },
        }),
      }),
    );
    const { client, companyId } = await companyWithAiProcessing(worker);
    const company = await getCompany(client, companyId);
    if (!company) throw new Error("Company missing");
    Object.assign(companyIdentity, company);
    const sourceFileId = await upload(
      { client, companyId },
      worker,
      "receipt.png",
      null,
    );

    await worker.runJobs();

    const [document] = await listDocuments(client, companyId, sourceFileId);
    const [version] = await listExtractionVersions(
      client,
      companyId,
      document.id,
    );
    expect(version.payload.direction).toBe(direction);
    expect(version.findings).not.toContainEqual(
      expect.objectContaining({ code: "direction_unknown" }),
    );
  });

  it("lets an upload preselection win", async () => {
    const worker = testWorker();
    const { client, companyId } = await companyWithAiProcessing(worker);
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
      preselectedDirection: "outgoing",
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    await worker.runJobs();

    const [document] = await listDocuments(client, companyId, uploaded.value.id);
    const [version] = await listExtractionVersions(client, companyId, document.id);
    expect(version.payload.direction).toBe("outgoing");
  });

  it("sets no Direction and records a warning when neither party matches", async () => {
    const worker = testWorker();
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload(
      { client, companyId },
      worker,
      "receipt.png",
      null,
    );

    await worker.runJobs();

    const [document] = await listDocuments(client, companyId, sourceFileId);
    const [version] = await listExtractionVersions(client, companyId, document.id);
    expect(version.payload.direction).toBeNull();
    expect(version.findings).toContainEqual({
      field: "direction",
      severity: "warning",
      code: "direction_unknown",
    });
  });
});

describe("foreign currency conversion", () => {
  it("stores original amounts and the ČNB-derived CZK amounts on the Extraction Version", async () => {
    const foreign = {
      ...SAMPLE_EXTRACTION,
      currency: "EUR",
      rateBreakdown: [{ rate: 21, netAmount: "10.00", vatAmount: "2.10" }],
      totals: { netAmount: "10.00", vatAmount: "2.10", grossAmount: "12.10" },
    };
    const worker = testWorker(fakeAiProvider({ extract: () => foreign }));
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker, "receipt.png");

    await worker.runJobs();

    const [document] = await listDocuments(client, companyId, sourceFileId);
    const [version] = await listExtractionVersions(client, companyId, document.id);
    expect(version.payload.totals).toEqual(foreign.totals);
    expect(version.payload.czkConversion).toEqual({
      originalCurrency: "EUR", rate: "25.00", unit: 1, rateDate: "2026-10-01", source: "CNB",
      rateBreakdown: [{ rate: 21, netAmount: "250.00", vatAmount: "52.50" }],
      totals: { netAmount: "250.00", vatAmount: "52.50", grossAmount: "302.50" },
    });
  });
});

describe("AI-processing consent", () => {
  /** A fake provider that counts the calls it receives. */
  function countingProvider() {
    const calls = { split: 0, extract: 0 };
    const ai = fakeAiProvider({
      split: (input) => {
        calls.split++;
        return Array.from({ length: input.pageCount }, (_, i) => ({ firstPage: i + 1, lastPage: i + 1 }));
      },
      extract: () => {
        calls.extract++;
        return SAMPLE_EXTRACTION;
      },
    });
    return { ai, calls };
  }

  it("is off for a new Company, so its Source Files wait without reaching the AI provider", async () => {
    const { ai, calls } = countingProvider();
    const worker = testWorker(ai);
    const { client, companyId } = await administratorWithCompany();

    const sourceFileId = await upload({ client, companyId }, worker);
    await worker.runJobs();

    expect((await getCompany(client, companyId))?.aiProcessingEnabled).toBe(false);
    expect(calls).toEqual({ split: 0, extract: 0 });
    expect((await getSourceFile(client, companyId, sourceFileId))?.status).toBe("uploaded");
    expect(await listDocuments(client, companyId, sourceFileId)).toEqual([]);
  });

  it("once enabled, processes the Source Files that waited for it", async () => {
    const { ai, calls } = countingProvider();
    const worker = testWorker(ai);
    const { client, companyId } = await administratorWithCompany();
    const sourceFileId = await upload({ client, companyId }, worker);
    await worker.runJobs();

    expect(await enableAiProcessing(client, worker.jobs, { companyId, provider: ai })).toEqual({ ok: true, value: null });
    await worker.runJobs();

    expect((await getCompany(client, companyId))?.aiProcessingEnabled).toBe(true);
    expect(calls).toEqual({ split: 1, extract: 2 });
    expect((await listDocuments(client, companyId, sourceFileId)).map((d) => d.status)).toEqual([
      "needs_review",
      "needs_review",
    ]);
  });

  it("once disabled, stops Documents from reaching the AI provider, even those already Split", async () => {
    const { ai, calls } = countingProvider();
    const worker = testWorker(ai);
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker);
    await worker.runJobs();
    const [document] = await listDocuments(client, companyId, sourceFileId);
    await reprocessDocument(client, worker.jobs, { companyId, documentId: document.id });

    expect(await disableAiProcessing(client, companyId)).toEqual({ ok: true, value: null });
    await upload({ client, companyId }, worker);
    await worker.runJobs();

    expect(calls).toEqual({ split: 1, extract: 2 });
    expect((await listDocuments(client, companyId, sourceFileId)).map((d) => d.status)).toEqual([
      "uploaded",
      "needs_review",
    ]);
  });

  it("retries Split on a provider-region mismatch, then marks the Source File failed", async () => {
    const worker = testWorker({ ...fakeAiProvider(), region: "elsewhere" });
    const { client, companyId } = await administratorWithCompany();
    await enableAiProcessing(client, worker.jobs, {
      companyId,
      provider: { name: "fake", region: "local" },
    });

    const sourceFileId = await upload({ client, companyId }, worker);
    await expect(worker.runJobs({ final: false })).resolves.toEqual([
      expect.objectContaining({
        message: 'AI provider "fake" in region "local" is not configured on this worker',
      }),
    ]);
    expect((await getSourceFile(client, companyId, sourceFileId))?.status).toBe("uploaded");

    worker.queued.push({ name: "split-source-file", data: { sourceFileId } });
    await expect(worker.runJobs()).resolves.toHaveLength(1);
    expect((await getSourceFile(client, companyId, sourceFileId))?.status).toBe("failed");
  });

  it("retries Split when this worker does not have the Company's selected provider, then fails clearly", async () => {
    const configured = testWorker();
    const unavailable = testWorker([]);
    const { client, companyId } = await companyWithAiProcessing(configured);
    const sourceFileId = await upload({ client, companyId }, unavailable, "receipt.png");

    await expect(unavailable.runJobs({ final: false })).resolves.toEqual([
      expect.objectContaining({
        message: 'AI provider "fake" in region "local" is not configured on this worker',
      }),
    ]);
    expect((await getSourceFile(client, companyId, sourceFileId))?.status).toBe("uploaded");

    unavailable.queued.push({ name: "split-source-file", data: { sourceFileId } });
    await expect(unavailable.runJobs()).resolves.toHaveLength(1);
    expect((await getSourceFile(client, companyId, sourceFileId))?.status).toBe("failed");
  });

  it("uses and audits the explicitly selected credential boundary", async () => {
    let fakeCalls = 0;
    const fake = fakeAiProvider({
      split: () => (++fakeCalls, [{ firstPage: 1, lastPage: 1 }]),
      extract: () => (++fakeCalls, SAMPLE_EXTRACTION),
    });
    const worker = testWorker(fake);
    const { client, userId, organizationId, companyId } = await administratorWithCompany();

    expect(await enableAiProcessing(client, worker.jobs, { companyId, provider: fake })).toEqual({
      ok: true,
      value: null,
    });
    const sourceFileId = await upload({ client, companyId }, worker, "receipt.png");
    await worker.runJobs();

    const [document] = await listDocuments(client, companyId, sourceFileId);
    expect(fakeCalls).toBe(2);
    expect((await listExtractionVersions(client, companyId, document.id))[0].author).toEqual({ kind: "ai" });
    expect((await getCompany(client, companyId))?.aiProcessingEnabled).toBe(true);
    await disableAiProcessing(client, companyId);

    const aiConsentEvents = (await listAuditEvents(client, organizationId))
      .filter((event) => event.action.startsWith("company.ai_processing_"));
    expect(aiConsentEvents.slice(-2)).toEqual([
      expect.objectContaining({
        action: "company.ai_processing_enabled",
        actorUserId: userId,
        companyId,
        payload: { provider: "fake", region: "local", credential_source: "local" },
      }),
      expect.objectContaining({
        action: "company.ai_processing_disabled",
        actorUserId: userId,
        companyId,
        payload: { provider: "fake", region: "local", credential_source: "local" },
      }),
    ]);
  });

  it("cannot be changed by another Organization, even through direct queries", async () => {
    const worker = testWorker();
    const a = await administratorWithCompany("Organization A");
    const b = await signedUpUser("Organization B");

    const enabled = await enableAiProcessing(b.client, worker.jobs, { companyId: a.companyId, provider: worker.ai });
    const direct = await b.client
      .from("company")
      .update({ ai_processing_enabled: true, ai_provider: "fake", ai_region: "local" })
      .eq("id", a.companyId)
      .select("id");

    expect(enabled).toEqual({ ok: false, error: "forbidden" });
    expect(direct.error?.code).toBe("42501");
    expect(direct.data).toBeNull();
    expect((await getCompany(a.client, a.companyId))?.aiProcessingEnabled).toBe(false);
  });
});

describe("Split", () => {
  it.each(["xlsx", "xls"] as const)("converts a .%s invoice list to text and creates one row-based Document per invoice", async (format) => {
    const splitInputs: AiInput[] = [];
    const extracted: AiInput[] = [];
    const worker = testWorker(fakeAiProvider({
      split: (input) => {
        splitInputs.push(input);
        return [
          { sheetName: "Invoices", firstRow: 2, lastRow: 2 },
          { sheetName: "Invoices", firstRow: 3, lastRow: 3 },
        ];
      },
      extract: (input) => {
        extracted.push(input);
        return extracted.length === 1 ? INVOICE_1 : INVOICE_2;
      },
    }));
    const { client, companyId } = await companyWithAiProcessing(worker);
    const bytes = workbookFile(format, [
      ["Document number", "Issue date", "Gross amount"],
      ["FV-1", new Date("2026-10-01T00:00:00.000Z"), 1210],
      ["FV-2", new Date("2026-10-02T00:00:00.000Z"), 2420.5],
    ]);
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      fileName: `invoice-list.${format}`,
      bytes,
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs()).toEqual([]);

    expect(new TextDecoder().decode(splitInputs[0].bytes)).toContain(
      '[Sheet "Invoices"]\n1\tDocument number\tIssue date\tGross amount\n2\tFV-1\t2026-10-01\t1210',
    );
    expect(extracted.map((input) => new TextDecoder().decode(input.bytes))).toEqual([
      '[Sheet "Invoices"]\n1\tDocument number\tIssue date\tGross amount\n2\tFV-1\t2026-10-01\t1210',
      '[Sheet "Invoices"]\n1\tDocument number\tIssue date\tGross amount\n3\tFV-2\t2026-10-02\t2420.5',
    ]);
    const documents = await listDocuments(client, companyId, uploaded.value.id);
    expect(documents).toEqual([
      expect.objectContaining({
        rowSet: { sheetName: "Invoices", firstRow: 2, lastRow: 2 },
        hasDocumentImage: false,
        status: "needs_review",
      }),
      expect.objectContaining({
        rowSet: { sheetName: "Invoices", firstRow: 3, lastRow: 3 },
        hasDocumentImage: false,
        status: "needs_review",
      }),
    ]);
    expect(await readDocumentRows(client, companyId, documents[1].id)).toEqual({
      fileName: `invoice-list.${format}`,
      sheetName: "Invoices",
      firstRow: 3,
      lastRow: 3,
      text: '[Sheet "Invoices"]\n1\tDocument number\tIssue date\tGross amount\n3\tFV-2\t2026-10-02\t2420.5',
    });
  });

  it("creates one Document when Split identifies a single invoice workbook", async () => {
    const worker = testWorker(fakeAiProvider({
      split: () => [{ sheetName: "Invoice", firstRow: 1, lastRow: 4 }],
    }));
    const { client, companyId } = await companyWithAiProcessing(worker);
    const bytes = workbookFile("xlsx", [
      ["Invoice number", "FV-100"],
      ["Issue date", new Date("2026-10-01T00:00:00.000Z")],
      ["Net", 1000],
      ["VAT", 210],
    ], "Invoice");
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      fileName: "invoice.xlsx",
      bytes,
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs()).toEqual([]);
    expect(await listDocuments(client, companyId, uploaded.value.id)).toEqual([
      expect.objectContaining({
        rowSet: { sheetName: "Invoice", firstRow: 1, lastRow: 4 },
        hasDocumentImage: false,
        status: "needs_review",
      }),
    ]);
  });

  it.each([
    ["an unknown sheet", [{ sheetName: "Missing", firstRow: 2, lastRow: 2 }]],
    ["a row past the worksheet", [{ sheetName: "Invoices", firstRow: 4, lastRow: 4 }]],
    ["overlapping row sets", [
      { sheetName: "Invoices", firstRow: 2, lastRow: 3 },
      { sheetName: "Invoices", firstRow: 3, lastRow: 3 },
    ]],
    ["a page range", [{ firstPage: 1, lastPage: 1 }]],
  ])("fails a workbook when the provider returns %s", async (_case, ranges) => {
    const worker = testWorker(fakeAiProvider({ split: () => ranges }));
    const { client, companyId } = await companyWithAiProcessing(worker);
    const bytes = workbookFile("xlsx", [
      ["Document number"],
      ["FV-1"],
      ["FV-2"],
    ]);
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      fileName: "invoice-list.xlsx",
      bytes,
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs()).toHaveLength(1);
    expect((await getSourceFile(client, companyId, uploaded.value.id))?.status).toBe("failed");
    expect(await listDocuments(client, companyId, uploaded.value.id)).toEqual([]);
  });

  it("records each Document with the page range the provider found", async () => {
    const extracted: AiInput[] = [];
    const worker = testWorker(
      fakeAiProvider({
        split: () => [{ firstPage: 1, lastPage: 2 }],
        extract: (input) => {
          extracted.push(input);
          return SAMPLE_EXTRACTION;
        },
      }),
    );
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker);

    await worker.runJobs();

    expect(await listDocuments(client, companyId, sourceFileId)).toEqual([
      expect.objectContaining({ firstPage: 1, lastPage: 2, status: "needs_review" }),
    ]);
    expect(extracted.map((input) => [input.mediaType, input.pageCount])).toEqual([["application/pdf", 2]]);
  });

  it("treats an image as one Document and sends it as uploaded", async () => {
    const extracted: AiInput[] = [];
    const worker = testWorker(fakeAiProvider({ extract: (input) => (extracted.push(input), SAMPLE_EXTRACTION) }));
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker, "receipt.png");

    await worker.runJobs();

    expect(await listDocuments(client, companyId, sourceFileId)).toEqual([
      expect.objectContaining({ firstPage: 1, lastPage: 1, status: "needs_review" }),
    ]);
    expect(extracted).toEqual([{ format: "png", mediaType: "image/png", bytes: fixtureFile("receipt.png"), pageCount: 1 }]);
  });

  it("sends a HEIC Source File's normalized JPEG derivative to Split and Extraction", async () => {
    const received: AiInput[] = [];
    const worker = testWorker(fakeAiProvider({
      split: (input) => {
        received.push(input);
        return [{ firstPage: 1, lastPage: 1 }];
      },
      extract: (input) => {
        received.push(input);
        return SAMPLE_EXTRACTION;
      },
    }));
    const { client, companyId } = await companyWithAiProcessing(worker);
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      fileName: "receipt.heic",
      bytes: heicFixture(),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs()).toEqual([]);

    expect((await getSourceFile(client, companyId, uploaded.value.id))?.format).toBe("heic");
    expect(received).toHaveLength(2);
    for (const input of received) {
      expect(input).toEqual(expect.objectContaining({
        format: "jpeg",
        mediaType: "image/jpeg",
        pageCount: 1,
      }));
      expect(input.bytes.slice(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    }
  });

  it.each([
    ["overlapping", [{ firstPage: 1, lastPage: 2 }, { firstPage: 2, lastPage: 2 }]],
    ["past the last page", [{ firstPage: 1, lastPage: 3 }]],
    ["empty", []],
  ])("fails the Source File when the provider returns %s page ranges", async (_case, ranges) => {
    const worker = testWorker(fakeAiProvider({ split: () => ranges }));
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker);

    const errors = await worker.runJobs();

    expect(errors).toHaveLength(1);
    expect((await getSourceFile(client, companyId, sourceFileId))?.status).toBe("failed");
    expect(await listDocuments(client, companyId, sourceFileId)).toEqual([]);
  });

  it("stays Processing while a failed attempt has retries left, then fails on the last one", async () => {
    const worker = testWorker(
      fakeAiProvider({
        split: () => {
          throw new Error("provider unavailable");
        },
      }),
    );
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker);

    await worker.runJobs({ final: false });
    expect((await getSourceFile(client, companyId, sourceFileId))?.status).toBe("processing");

    worker.queued.push({ name: "split-source-file", data: { sourceFileId } });
    await worker.runJobs();
    expect((await getSourceFile(client, companyId, sourceFileId))?.status).toBe("failed");
  });

  it("can be retried after it failed", async () => {
    let available = false;
    const worker = testWorker(
      fakeAiProvider({
        split: (input) => {
          if (!available) throw new Error("provider unavailable");
          return [{ firstPage: 1, lastPage: input.pageCount }];
        },
      }),
    );
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker);
    await worker.runJobs();
    available = true;

    expect(await retrySplit(client, worker.jobs, { companyId, sourceFileId })).toEqual({ ok: true, value: null });
    await worker.runJobs();

    expect((await getSourceFile(client, companyId, sourceFileId))?.status).toBe("split");
    expect((await listDocuments(client, companyId, sourceFileId)).map((d) => d.status)).toEqual(["needs_review"]);
  });

  it("is retried only after it failed", async () => {
    const worker = testWorker();
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker);
    await worker.runJobs();

    expect(await retrySplit(client, worker.jobs, { companyId, sourceFileId })).toEqual({
      ok: false,
      error: "not_retryable",
    });
  });

  it("creates no duplicate Documents when its job runs again", async () => {
    const worker = testWorker();
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker);
    worker.queued.push(...worker.queued);

    await worker.runJobs();
    worker.queued.push({ name: "split-source-file", data: { sourceFileId } });
    await worker.runJobs();

    const documents = await listDocuments(client, companyId, sourceFileId);
    expect(documents.map((d) => [d.firstPage, d.status])).toEqual([
      [1, "needs_review"],
      [2, "needs_review"],
    ]);
    for (const document of documents) {
      expect(await listExtractionVersions(client, companyId, document.id)).toHaveLength(1);
    }
  });
});

describe("Extraction", () => {
  it("retries when this worker does not have the Company's selected provider, then fails the Document clearly", async () => {
    const configured = testWorker();
    const unavailable = testWorker([]);
    const { client, companyId } = await companyWithAiProcessing(configured);
    const sourceFileId = await upload({ client, companyId }, configured, "receipt.png");
    await configured.runNextJob();
    const [document] = await listDocuments(client, companyId, sourceFileId);
    unavailable.queued.push({ name: "extract-document", data: { documentId: document.id } });

    await expect(unavailable.runJobs({ final: false })).resolves.toEqual([
      expect.objectContaining({
        message: 'AI provider "fake" in region "local" is not configured on this worker',
      }),
    ]);
    expect((await listDocuments(client, companyId, sourceFileId))[0].status).toBe("uploaded");

    unavailable.queued.push({ name: "extract-document", data: { documentId: document.id } });
    await expect(unavailable.runJobs()).resolves.toHaveLength(1);
    expect((await listDocuments(client, companyId, sourceFileId))[0].status).toBe("failed");
  });

  it("fails only the Document whose Extraction failed, and can be retried", async () => {
    let failing = true;
    let calls = 0;
    const worker = testWorker(
      fakeAiProvider({
        extract: () => {
          calls++;
          if (failing && calls === 2) throw new Error("provider unavailable");
          return SAMPLE_EXTRACTION;
        },
      }),
    );
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker);
    await worker.runJobs();
    const [, second] = await listDocuments(client, companyId, sourceFileId);
    expect((await listDocuments(client, companyId, sourceFileId)).map((d) => d.status)).toEqual([
      "needs_review",
      "failed",
    ]);
    expect(await listExtractionVersions(client, companyId, second.id)).toEqual([]);
    failing = false;

    expect(await reprocessDocument(client, worker.jobs, { companyId, documentId: second.id })).toEqual({
      ok: true,
      value: null,
    });
    expect((await listDocuments(client, companyId, sourceFileId))[1].status).toBe("uploaded");
    await worker.runJobs();

    expect((await listDocuments(client, companyId, sourceFileId))[1].status).toBe("needs_review");
    expect((await listExtractionVersions(client, companyId, second.id)).map((v) => v.version)).toEqual([1]);
  });

  it("can be run again on a reviewed Document, adding a new Extraction Version and keeping the earlier one", async () => {
    let run = 0;
    const worker = testWorker(fakeAiProvider({ extract: () => (++run === 1 ? INVOICE_1 : INVOICE_2) }));
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker, "receipt.png");
    await worker.runJobs();
    const [document] = await listDocuments(client, companyId, sourceFileId);

    await reprocessDocument(client, worker.jobs, { companyId, documentId: document.id });
    await worker.runJobs();

    expect((await listDocuments(client, companyId, sourceFileId))[0].status).toBe("needs_review");
    expect(
      (await listExtractionVersions(client, companyId, document.id)).map((v) => [v.version, v.payload.documentNumber]),
    ).toEqual([
      [1, "FV-1"],
      [2, "FV-2"],
    ]);
  });

  it("is not run again while the Document is still being processed", async () => {
    const worker = testWorker();
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker, "receipt.png");
    await worker.runJobs();
    const [document] = await listDocuments(client, companyId, sourceFileId);
    await reprocessDocument(client, worker.jobs, { companyId, documentId: document.id });

    expect(await reprocessDocument(client, worker.jobs, { companyId, documentId: document.id })).toEqual({
      ok: false,
      error: "not_reprocessable",
    });
  });

  it("records one Extraction Version when the same request runs twice", async () => {
    const worker = testWorker();
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker, "receipt.png");
    await worker.runJobs();
    const [document] = await listDocuments(client, companyId, sourceFileId);
    await reprocessDocument(client, worker.jobs, { companyId, documentId: document.id });
    worker.queued.push(...worker.queued);

    await worker.runJobs();

    expect((await listExtractionVersions(client, companyId, document.id)).map((v) => v.version)).toEqual([1, 2]);
  });
});

describe("jobs running at the same time", () => {
  /** Holds every AI call until `release` is called, so concurrent jobs overlap. */
  function gate() {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    return { opened, release };
  }

  it("Split a Source File into one set of Documents, whatever ranges each run finds", async () => {
    const { opened, release } = gate();
    let run = 0;
    const worker = testWorker(
      fakeAiProvider({
        split: async () => {
          const ranges = ++run === 1 ? [{ firstPage: 1, lastPage: 2 }] : [{ firstPage: 1, lastPage: 1 }, { firstPage: 2, lastPage: 2 }];
          if (run === 2) release();
          await opened;
          return ranges;
        },
      }),
    );
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker);
    worker.queued.push(...worker.queued);

    await worker.runJobsConcurrently();

    const ranges = (await listDocuments(client, companyId, sourceFileId)).map((d) => [d.firstPage, d.lastPage]);
    expect([JSON.stringify([[1, 2]]), JSON.stringify([[1, 1], [2, 2]])]).toContain(JSON.stringify(ranges));
  });

  it("leaves a Document in review when the same Extract job runs twice", async () => {
    const worker = testWorker();
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker, "receipt.png");
    await worker.runJobs();
    const [document] = await listDocuments(client, companyId, sourceFileId);
    await reprocessDocument(client, worker.jobs, { companyId, documentId: document.id });
    worker.queued.push(...worker.queued);
    await worker.runJobsConcurrently();

    expect((await listDocuments(client, companyId, sourceFileId))[0].status).toBe("needs_review");
    expect((await listExtractionVersions(client, companyId, document.id)).map((v) => v.version)).toEqual([1, 2]);
  });

  it("still enqueue the Extract jobs when a Split job runs again after recording the Split", async () => {
    const worker = testWorker();
    const { client, companyId } = await companyWithAiProcessing(worker);
    const sourceFileId = await upload({ client, companyId }, worker);
    const send = worker.jobs.send;
    worker.jobs.send = async () => {
      throw new Error("queue unavailable");
    };
    await worker.runJobs({ final: false });
    worker.jobs.send = send;

    worker.queued.push({ name: "split-source-file", data: { sourceFileId } });
    await worker.runJobs();

    expect((await listDocuments(client, companyId, sourceFileId)).map((d) => d.status)).toEqual([
      "needs_review",
      "needs_review",
    ]);
  });
});
