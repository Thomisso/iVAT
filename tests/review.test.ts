import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import { enableAiProcessing } from "@/application/companies";
import {
  approveDocument,
  correctDocument,
  getDocument,
  listCompanyDocuments,
  listDocuments,
  listExtractionVersions,
  readDocumentPages,
  rejectDocument,
  reprocessDocument,
  type DocumentFilters,
} from "@/application/documents";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { uploadSourceFile } from "@/application/source-files";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { signedUpUser } from "./support/clients";
import { fixtureFile } from "./support/files";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { testWorker } from "./support/worker";
import { fakeExchangeRates } from "@/cnb/fake";

/** An Administrator whose Company holds one Document in NeedsReview, Extracted as `extraction`. */
async function documentInReview(extraction: ExtractionPayload = SAMPLE_EXTRACTION) {
  const worker = testWorker(fakeAiProvider({ extract: () => extraction }));
  const admin = await administratorWithCompany();
  const enabled = await enableAiProcessing(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
  if (!enabled.ok) throw new Error(enabled.error);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, {
    companyId: admin.companyId,
    fileName: "receipt.png",
    bytes: fixtureFile("receipt.png"),
    preselectedDirection: extraction.direction ?? undefined,
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await worker.runJobs();
  const [document] = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  return { ...admin, worker, sourceFileId: uploaded.value.id, documentId: document.id };
}

/** SAMPLE_EXTRACTION as a User corrects it: an outgoing invoice under domestic reverse charge at two rates. */
const CORRECTED: ExtractionPayload = {
  ...SAMPLE_EXTRACTION,
  documentNumber: "FV-2026-0002",
  direction: "outgoing",
  proposedVatRegime: "domestic_reverse_charge",
  rateBreakdown: [
    { rate: 21, netAmount: "1000.00", vatAmount: "210.00" },
    { rate: 12, netAmount: "500.00", vatAmount: "60.00" },
  ],
  totals: { netAmount: "1500.00", vatAmount: "270.00", grossAmount: "1770.00" },
};

describe("correcting a Document", () => {
  it("re-applies the ČNB rate when currency and Tax Point Date change", async () => {
    const foreign = { ...SAMPLE_EXTRACTION, currency: "EUR", taxPointDate: "2026-10-01" };
    const { client, companyId, documentId } = await documentInReview(foreign);

    await correctDocument(
      client,
      {
        companyId, documentId, basedOnVersion: 1,
        payload: { ...foreign, currency: "USD", taxPointDate: "2026-10-02" },
      },
      fakeExchangeRates("20.00"),
    );

    const versions = await listExtractionVersions(client, companyId, documentId);
    expect(versions[0].payload.czkConversion).toEqual(
      expect.objectContaining({ originalCurrency: "EUR", rate: "25.00", rateDate: "2026-10-01" }),
    );
    expect(versions[1].payload.czkConversion).toEqual(
      expect.objectContaining({ originalCurrency: "USD", rate: "20.00", rateDate: "2026-10-02" }),
    );
  });

  it("stores deterministic findings with each immutable Extraction Version", async () => {
    const invalid = {
      ...SAMPLE_EXTRACTION,
      supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: "CZ27082441" },
    };
    const { client, companyId, documentId } = await documentInReview(invalid);

    await correctDocument(client, {
      companyId,
      documentId,
      basedOnVersion: 1,
      payload: SAMPLE_EXTRACTION,
    });

    const versions = await listExtractionVersions(client, companyId, documentId);
    expect(versions.map((version) => version.findings)).toEqual([
      [
        {
          field: "supplier.vatId",
          severity: "error",
          code: "invalid_vat_id_checksum",
        },
      ],
      [],
    ]);
  });

  it("saves the corrections as a new Extraction Version authored by the User, without the AI's confidence, keeping the AI one", async () => {
    const { client, userId, companyId, documentId } = await documentInReview();

    const result = await correctDocument(client, { companyId, documentId, basedOnVersion: 1, payload: CORRECTED });

    expect(result).toEqual({ ok: true, value: { version: 2 } });
    const versions = await listExtractionVersions(client, companyId, documentId);
    expect(versions.map((v) => [v.version, v.author])).toEqual([
      [1, { kind: "ai", provider: "fake", model: "fake-extract" }],
      [2, { kind: "user", userId }],
    ]);
    expect(versions[0].payload).toEqual(SAMPLE_EXTRACTION);
    expect(versions[1].payload).toEqual({ ...CORRECTED, confidence: undefined });
    expect(versions[1].payload).not.toHaveProperty("confidence");
  });

  it("is audited with the version it created", async () => {
    const { client, userId, organizationId, companyId, documentId } = await documentInReview();

    await correctDocument(client, { companyId, documentId, basedOnVersion: 1, payload: CORRECTED });

    expect((await listAuditEvents(client, organizationId)).at(-1)).toEqual(
      expect.objectContaining({
        action: "document.corrected",
        actorUserId: userId,
        companyId,
        targetType: "document",
        targetId: documentId,
        payload: { version: 2 },
      }),
    );
  });

  it("refuses corrections based on a version that is no longer the latest", async () => {
    const { client, companyId, documentId } = await documentInReview();
    await correctDocument(client, { companyId, documentId, basedOnVersion: 1, payload: CORRECTED });

    const result = await correctDocument(client, { companyId, documentId, basedOnVersion: 1, payload: SAMPLE_EXTRACTION });

    expect(result).toEqual({ ok: false, error: "stale_version" });
    expect((await listExtractionVersions(client, companyId, documentId)).map((v) => v.version)).toEqual([1, 2]);
  });

  it("is refused while the Document is being processed again", async () => {
    const { client, worker, companyId, documentId } = await documentInReview();
    await reprocessDocument(client, worker.jobs, { companyId, documentId });

    const result = await correctDocument(client, { companyId, documentId, basedOnVersion: 1, payload: CORRECTED });

    expect(result).toEqual({ ok: false, error: "not_in_review" });
  });

  it.each([
    ["an amount that is no number", { totals: { ...SAMPLE_EXTRACTION.totals, grossAmount: "1210 Kč" } }, "invalid_amount"],
    ["a Rate Breakdown amount with three decimals", { rateBreakdown: [{ rate: 21, netAmount: "1000.005", vatAmount: "210.00" }] }, "invalid_amount"],
    ["a negative VAT rate", { rateBreakdown: [{ rate: -21, netAmount: "1000.00", vatAmount: "210.00" }] }, "invalid_rate"],
    ["a date that does not exist", { taxPointDate: "2026-02-30" }, "invalid_date"],
    ["a currency that is not an ISO code", { currency: "Kč" }, "invalid_currency"],
    ["a country that is not an ISO code", { supplier: { ...SAMPLE_EXTRACTION.supplier, country: "CZE" } }, "invalid_country"],
    ["an unknown document type", { documentType: "invoic" as ExtractionPayload["documentType"] }, "invalid_choice"],
    ["an unknown Direction", { direction: "sideways" as ExtractionPayload["direction"] }, "invalid_choice"],
    ["an unknown VAT Regime", { proposedVatRegime: "export" as ExtractionPayload["proposedVatRegime"] }, "invalid_choice"],
  ] satisfies [string, Partial<ExtractionPayload>, string][])("refuses %s", async (_case, change, error) => {
    const { client, companyId, documentId } = await documentInReview();

    const result = await correctDocument(client, {
      companyId,
      documentId,
      basedOnVersion: 1,
      payload: { ...SAMPLE_EXTRACTION, ...change },
    });

    expect(result).toEqual({ ok: false, error });
    expect(await listExtractionVersions(client, companyId, documentId)).toHaveLength(1);
  });

  it("reads amounts and codes as people type them", async () => {
    const { client, companyId, documentId } = await documentInReview();
    const typed: ExtractionPayload = {
      ...SAMPLE_EXTRACTION,
      currency: " czk ",
      supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: "cz 27082440", country: "cz" },
      rateBreakdown: [{ rate: 21, netAmount: "1 000", vatAmount: "210,5" }],
      totals: { netAmount: "1000", vatAmount: "210.5", grossAmount: " 1 210,50 " },
    };

    await correctDocument(client, { companyId, documentId, basedOnVersion: 1, payload: typed });

    const [, corrected] = await listExtractionVersions(client, companyId, documentId);
    expect(corrected.payload).toEqual(
      expect.objectContaining({
        currency: "CZK",
        supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: "CZ27082440", country: "CZ" },
        rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "210.50" }],
        totals: { netAmount: "1000.00", vatAmount: "210.50", grossAmount: "1210.50" },
      }),
    );
  });

  it("refuses a Rate Breakdown line without its amounts", async () => {
    const { client, companyId, documentId } = await documentInReview();
    const payload = { ...SAMPLE_EXTRACTION, rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "" }] };

    expect(await correctDocument(client, { companyId, documentId, basedOnVersion: 1, payload })).toEqual({
      ok: false,
      error: "invalid_amount",
    });
  });

  it("accepts negative amounts of a Credit Note and fields left empty", async () => {
    const { client, companyId, documentId } = await documentInReview();
    const creditNote: ExtractionPayload = {
      ...SAMPLE_EXTRACTION,
      documentType: "credit_note",
      dueDate: null,
      originalDocumentNumber: "FV-2026-0001",
      rateBreakdown: [{ rate: 21, netAmount: "-100.00", vatAmount: "-21.00" }],
      totals: { netAmount: "-100.00", vatAmount: "-21.00", grossAmount: null },
    };

    expect(await correctDocument(client, { companyId, documentId, basedOnVersion: 1, payload: creditNote })).toEqual({
      ok: true,
      value: { version: 2 },
    });
  });
});

describe("approving and rejecting a Document", () => {
  it("refuses approval while Direction is unknown", async () => {
    const document = await documentInReview({
      ...SAMPLE_EXTRACTION,
      direction: null,
    });

    expect(
      await approveDocument(document.client, { ...document, version: 1 }),
    ).toEqual({ ok: false, error: "direction_required" });
    expect(
      (await listDocuments(
        document.client,
        document.companyId,
        document.sourceFileId,
      ))[0].status,
    ).toBe("needs_review");
  });

  it("allows approval after a User sets the unknown Direction", async () => {
    const document = await documentInReview({
      ...SAMPLE_EXTRACTION,
      direction: null,
    });

    expect(
      await correctDocument(document.client, {
        ...document,
        basedOnVersion: 1,
        payload: SAMPLE_EXTRACTION,
      }),
    ).toEqual({ ok: true, value: { version: 2 } });
    expect(
      await approveDocument(document.client, { ...document, version: 2 }),
    ).toEqual({ ok: true, value: null });
  });

  it("lets a User of the Company approve the version they reviewed, and audits it", async () => {
    const document = await documentInReview();
    const member = await companyMember(document);

    const result = await approveDocument(member.client, { ...document, version: 1 });

    expect(result).toEqual({ ok: true, value: null });
    expect((await listDocuments(member.client, document.companyId, document.sourceFileId))[0].status).toBe("approved");
    expect((await listAuditEvents(document.client, document.organizationId)).at(-1)).toEqual(
      expect.objectContaining({
        action: "document.approved",
        actorUserId: member.userId,
        companyId: document.companyId,
        targetType: "document",
        targetId: document.documentId,
        payload: { version: 1 },
      }),
    );
  });

  it("lets an Administrator approve the User's corrections", async () => {
    const document = await documentInReview();
    const member = await companyMember(document);
    await correctDocument(member.client, { ...document, basedOnVersion: 1, payload: CORRECTED });

    expect(await approveDocument(document.client, { ...document, version: 2 })).toEqual({ ok: true, value: null });
  });

  it("refuses to approve a version that is no longer the latest", async () => {
    const document = await documentInReview();
    await correctDocument(document.client, { ...document, basedOnVersion: 1, payload: CORRECTED });

    expect(await approveDocument(document.client, { ...document, version: 1 })).toEqual({
      ok: false,
      error: "stale_version",
    });
    expect((await listDocuments(document.client, document.companyId, document.sourceFileId))[0].status).toBe(
      "needs_review",
    );
  });

  it("lets an Administrator reject a Document", async () => {
    const document = await documentInReview();

    expect(await rejectDocument(document.client, document)).toEqual({ ok: true, value: null });
    expect((await listDocuments(document.client, document.companyId, document.sourceFileId))[0].status).toBe("rejected");
  });

  it("lets a User of the Company reject a Document, and audits it", async () => {
    const document = await documentInReview();
    const member = await companyMember(document);

    expect(await rejectDocument(member.client, document)).toEqual({ ok: true, value: null });

    expect((await listDocuments(member.client, document.companyId, document.sourceFileId))[0].status).toBe("rejected");
    expect((await listAuditEvents(document.client, document.organizationId)).at(-1)).toEqual(
      expect.objectContaining({
        action: "document.rejected",
        actorUserId: member.userId,
        companyId: document.companyId,
        targetType: "document",
        targetId: document.documentId,
      }),
    );
  });

  it("closes the review: a decided Document can no longer be corrected, decided again or reprocessed", async () => {
    const approved = await documentInReview();
    await approveDocument(approved.client, { ...approved, version: 1 });
    const rejected = await documentInReview();
    await rejectDocument(rejected.client, rejected);

    for (const document of [approved, rejected]) {
      expect(await correctDocument(document.client, { ...document, basedOnVersion: 1, payload: CORRECTED })).toEqual({
        ok: false,
        error: "not_in_review",
      });
      expect(await approveDocument(document.client, { ...document, version: 1 })).toEqual({
        ok: false,
        error: "not_in_review",
      });
      expect(await rejectDocument(document.client, document)).toEqual({ ok: false, error: "not_in_review" });
      expect(await reprocessDocument(document.client, document.worker.jobs, document)).toEqual({
        ok: false,
        error: "not_reprocessable",
      });
    }
  });
});

describe("the Document list", () => {
  /** An Administrator whose Company holds one Document in review per extraction, Extracted in that order. */
  async function companyWithDocuments(...extractions: ExtractionPayload[]) {
    let run = 0;
    const worker = testWorker(fakeAiProvider({ extract: () => extractions[run++] }));
    const admin = await administratorWithCompany();
    await enableAiProcessing(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
    const sourceFileIds: string[] = [];
    for (let i = 0; i < extractions.length; i++) {
      const uploaded = await uploadSourceFile(admin.client, worker.jobs, {
        companyId: admin.companyId,
        fileName: "receipt.png",
        bytes: fixtureFile("receipt.png"),
        preselectedDirection: extractions[i].direction ?? undefined,
      });
      if (!uploaded.ok) throw new Error(uploaded.error);
      sourceFileIds.push(uploaded.value.id);
    }
    await worker.runJobs();
    const documentIds = [];
    for (const id of sourceFileIds) documentIds.push((await listDocuments(admin.client, admin.companyId, id))[0].id);
    return { ...admin, documentIds };
  }

  const PURCHASE: ExtractionPayload = { ...SAMPLE_EXTRACTION, documentNumber: "FP-1", taxPointDate: "2026-10-01" };
  const SALE: ExtractionPayload = {
    ...SAMPLE_EXTRACTION,
    documentNumber: "FV-1",
    taxPointDate: "2026-11-03",
    direction: "outgoing",
    supplier: { ...SAMPLE_EXTRACTION.customer },
    customer: { ...SAMPLE_EXTRACTION.supplier, name: "Odběratel a.s.", ico: "45274649", vatId: "CZ45274649" },
    totals: { netAmount: "2000.00", vatAmount: "420.00", grossAmount: "2420.00" },
  };
  const UNREADABLE: ExtractionPayload = {
    ...SAMPLE_EXTRACTION,
    documentNumber: null,
    taxPointDate: null,
    direction: null,
    supplier: SAMPLE_EXTRACTION.customer,
  };

  it("shows each Document's current data, flagging only Approved Documents as eligible for VAT Reports", async () => {
    const company = await companyWithDocuments(PURCHASE, SALE, UNREADABLE);
    const [purchase, sale, unreadable] = company.documentIds;
    const { companyId } = company;
    await correctDocument(company.client, { companyId, documentId: purchase, basedOnVersion: 1, payload: { ...PURCHASE, documentNumber: "FP-1a" } });
    await approveDocument(company.client, { companyId, documentId: purchase, version: 2 });

    const documents = await listCompanyDocuments(company.client, companyId);

    expect(documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: purchase,
          status: "approved",
          version: 2,
          documentNumber: "FP-1a",
          direction: "incoming",
          taxPointDate: "2026-10-01",
          reportingPeriod: "2026-10",
          counterparty: { name: "Dodavatel s.r.o.", vatId: "CZ27082440", ico: "27082440" },
          currency: "CZK",
          grossAmount: "1210.00",
          eligibleForVatReport: true,
        }),
        expect.objectContaining({
          id: sale,
          status: "needs_review",
          version: 1,
          documentNumber: "FV-1",
          direction: "outgoing",
          reportingPeriod: "2026-11",
          counterparty: { name: "Odběratel a.s.", vatId: "CZ45274649", ico: "45274649" },
          grossAmount: "2420.00",
          eligibleForVatReport: false,
        }),
        expect.objectContaining({
          id: unreadable,
          documentNumber: null,
          direction: null,
          reportingPeriod: null,
          counterparty: null,
          eligibleForVatReport: false,
        }),
      ]),
    );
    expect(documents).toHaveLength(3);
  });

  it("filters by status, Direction, Reporting Period and counterparty", async () => {
    const company = await companyWithDocuments(PURCHASE, SALE, UNREADABLE);
    const [purchase, sale] = company.documentIds;
    const { client, companyId } = company;
    await approveDocument(client, { companyId, documentId: purchase, version: 1 });
    const ids = async (filters: DocumentFilters) => (await listCompanyDocuments(client, companyId, filters)).map((d) => d.id);

    expect(await ids({ status: "approved" })).toEqual([purchase]);
    expect(await ids({ direction: "outgoing" })).toEqual([sale]);
    expect(await ids({ reportingPeriod: "2026-10" })).toEqual([purchase]);
    expect(await ids({ counterparty: "odběratel" })).toEqual([sale]);
    expect(await ids({ counterparty: "CZ2708" })).toEqual([purchase]);
    expect(await ids({ counterparty: "45274649" })).toEqual([sale]);
    expect(await ids({ counterparty: "%" })).toEqual([]);
    expect(await ids({ counterparty: "_" })).toEqual([]);
    expect(await ids({ direction: "incoming", status: "needs_review" })).toEqual([]);
  });

  it("filters the Document list to current Extraction Versions with findings", async () => {
    const invalid = {
      ...PURCHASE,
      documentNumber: "FP-invalid",
      supplier: { ...PURCHASE.supplier, ico: "27082441" },
    };
    const company = await companyWithDocuments(PURCHASE, invalid);
    const [, invalidDocument] = company.documentIds;

    expect(
      await listCompanyDocuments(company.client, company.companyId, {
        hasFindings: true,
      }),
    ).toEqual([
      expect.objectContaining({
        id: invalidDocument,
        findingCount: 1,
      }),
    ]);
  });

  it("still lists a Document whose AI Extraction read a malformed date, without a Reporting Period", async () => {
    const company = await companyWithDocuments({ ...PURCHASE, taxPointDate: "27.10.2026" });

    expect(await listCompanyDocuments(company.client, company.companyId)).toEqual([
      expect.objectContaining({ taxPointDate: "27.10.2026", reportingPeriod: null }),
    ]);
  });

  it("shows nothing of another Organization, even to direct queries", async () => {
    const a = await companyWithDocuments(PURCHASE);
    const b = await signedUpUser("Organization B");

    const direct = await b.client.from("document_overview").select("id").eq("company_id", a.companyId);

    expect(await listCompanyDocuments(b.client, a.companyId)).toEqual([]);
    expect(direct.data).toEqual([]);
  });
});

describe("the review workspace", () => {
  it("shows a Document of a PDF as just its own pages", async () => {
    const worker = testWorker(fakeAiProvider({ split: () => [{ firstPage: 1, lastPage: 1 }, { firstPage: 2, lastPage: 2 }] }));
    const { client, companyId } = await administratorWithCompany();
    await enableAiProcessing(client, worker.jobs, { companyId, provider: worker.ai });
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      fileName: "two-invoices.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await worker.runJobs();
    const [, second] = await listDocuments(client, companyId, uploaded.value.id);

    const pages = await readDocumentPages(client, companyId, second.id);

    expect(pages?.mediaType).toBe("application/pdf");
    expect(pages?.fileName).toBe("two-invoices.pdf");
    const pdf = await PDFDocument.load(pages!.bytes);
    expect(pdf.getPageCount()).toBe(1);
  });

  it("shows a Document of an image as the image, unchanged", async () => {
    const { client, companyId, documentId } = await documentInReview();

    expect(await readDocumentPages(client, companyId, documentId)).toEqual({
      fileName: "receipt.png",
      mediaType: "image/png",
      bytes: fixtureFile("receipt.png"),
    });
  });

  it("gives another Organization neither the Document nor its pages", async () => {
    const a = await documentInReview();
    const b = await signedUpUser("Organization B");

    expect(await getDocument(b.client, a.companyId, a.documentId)).toBeNull();
    expect(await readDocumentPages(b.client, a.companyId, a.documentId)).toBeNull();
    expect(await approveDocument(b.client, { ...a, version: 1 })).toEqual({ ok: false, error: "forbidden" });
    expect(await rejectDocument(b.client, a)).toEqual({ ok: false, error: "forbidden" });
    expect(await correctDocument(b.client, { ...a, basedOnVersion: 1, payload: CORRECTED })).toEqual({
      ok: false,
      error: "forbidden",
    });
    for (const attempt of [
      await b.client.rpc("approve_document", { target_document_id: a.documentId, reviewed_version: 1 }),
      await b.client.rpc("reject_document", { target_document_id: a.documentId }),
      await b.client.rpc("correct_document", {
        target_document_id: a.documentId,
        based_on_version: 1,
        payload: {},
        findings: [],
      }),
    ]) {
      expect(attempt.error?.code).toBe("42501");
    }
    expect(await getDocument(a.client, a.companyId, a.documentId)).toEqual(
      expect.objectContaining({ id: a.documentId, status: "needs_review" }),
    );
    expect(await listExtractionVersions(a.client, a.companyId, a.documentId)).toHaveLength(1);
  });
});
