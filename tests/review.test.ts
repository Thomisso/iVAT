import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { Client as DatabaseClient } from "pg";
import { describe, expect, inject, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import {
  approveDocument,
  listDeferredClaimPeriods,
  correctDocument,
  getDocument,
  listCompanyDocuments,
  listDocuments,
  listExtractionVersions,
  readDocumentPages,
  rejectDocument,
  reprocessDocument,
  updateDocumentReporting,
  returnDocumentToReview,
  type DocumentFilters,
} from "@/application/documents";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { generateVatReport, getVatReport } from "@/application/vat-reports";
import { uploadSourceFile } from "@/application/source-files";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { provisionedUser } from "./support/clients";
import { fixtureFile } from "./support/files";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
  companyMember,
} from "./support/fixtures";
import { testWorker } from "./support/worker";
import { fakeExchangeRates } from "@/cnb/fake";
import { addLegacyRateBreakdownVersionFixture } from "./support/rate-breakdown-history";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";

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
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await worker.runJobs();
  const [document] = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  return { ...admin, worker, sourceFileId: uploaded.value.id, documentId: document.id };
}

/** SAMPLE_EXTRACTION without the customer identity that would reveal the Company's Direction. */
const UNDETECTED: ExtractionPayload = {
  ...SAMPLE_EXTRACTION,
  direction: null,
  customer: { ...SAMPLE_EXTRACTION.customer, ico: null, vatId: null },
};

/** SAMPLE_EXTRACTION as a User corrects it: an outgoing invoice under domestic reverse charge at two rates. */
const CORRECTED: ExtractionPayload = {
  ...SAMPLE_EXTRACTION,
  documentNumber: "FV-2026-0002",
  direction: "outgoing",
  supplier: SAMPLE_EXTRACTION.customer,
  customer: SAMPLE_EXTRACTION.supplier,
  proposedVatRegime: "domestic_reverse_charge",
  reverseChargeCode: "4",
  rateBreakdown: [
    { rate: 21, netAmount: "1000.00", vatAmount: "210.00" },
    { rate: 12, netAmount: "500.00", vatAmount: "60.00" },
  ],
  totals: { netAmount: "1500.00", vatAmount: "270.00", grossAmount: "1770.00" },
};

describe("correcting a Document", () => {
  it("keeps historical zero rows immutable while report preparation and later corrections omit them", async () => {
    const document = await documentInReview();
    await addLegacyRateBreakdownVersionFixture(inject("databaseUrl"), document.documentId);
    const [, legacy] = await listExtractionVersions(document.client, document.companyId, document.documentId);
    expect(legacy.payload.rateBreakdown).toHaveLength(3);
    expect(legacy.payload.confidence).toEqual({ "rateBreakdown.1.netAmount": 0.62, "rateBreakdown.2.vatAmount": 0.45 });
    expect(legacy.findings).toContainEqual({ field: "rateBreakdown.2.vatAmount", severity: "error", code: "rate_vat_amount_mismatch" });
    expect(await approveDocument(document.client, { ...document, version: 2 })).toEqual({ ok: true, value: null });
    expect((await generateVatReport(document.client, { companyId: document.companyId, period: "2026-10" })).ok).toBe(true);
    const report = await getVatReport(document.client, document.companyId, "2026-10");
    expect(report?.result.excludedDocuments).toEqual([]);
    expect(report?.result.controlStatement.flatMap((entry) => entry.rateBreakdown.map(({ rate, netAmount, vatAmount }) => ({ rate, netAmount, vatAmount })))).toEqual([
      { rate: 12, netAmount: "-1250.00", vatAmount: "-150.00" },
      { rate: 21, netAmount: "-2500.00", vatAmount: "-525.00" },
    ]);
    expect(await returnDocumentToReview(document.client, document)).toEqual({ ok: true, value: null });
    expect(await correctDocument(document.client, { ...document, basedOnVersion: 2, payload: legacy.payload }, fakeExchangeRates())).toEqual({ ok: true, value: { version: 3 } });
    const versions = await listExtractionVersions(document.client, document.companyId, document.documentId);
    expect(versions[1].payload).toEqual(legacy.payload);
    expect(versions[2].payload.rateBreakdown).toEqual([
      { rate: 12, netAmount: "-50.00", vatAmount: "0.00" },
      { rate: 21, netAmount: "-100.00", vatAmount: "-20.00" },
    ]);
  });
  it("prepares new AI rates and CZK conversion without empty rows and remaps confidence to the retained fields", async () => {
    const extraction: ExtractionPayload = {
      ...SAMPLE_EXTRACTION,
      currency: "EUR",
      rateBreakdown: [
        { rate: 0, netAmount: "0.00", vatAmount: "0.00" },
        { rate: 21, netAmount: "100.00", vatAmount: "21.00" },
        { rate: 12, netAmount: "50.00", vatAmount: "0.00" },
        { rate: 12, netAmount: "-0.00", vatAmount: "0.00" },
      ],
      totals: { netAmount: "150.00", vatAmount: "21.00", grossAmount: "171.00" },
      confidence: { documentNumber: 0.98, "rateBreakdown.0.netAmount": 0.99, "rateBreakdown.1.vatAmount": 0.45, "rateBreakdown.2.netAmount": 0.62 },
    };
    const document = await documentInReview(extraction);
    const [version] = await listExtractionVersions(document.client, document.companyId, document.documentId);
    expect(version.payload.rateBreakdown).toEqual([
      { rate: 21, netAmount: "100.00", vatAmount: "21.00" },
      { rate: 12, netAmount: "50.00", vatAmount: "0.00" },
    ]);
    expect(version.payload.confidence).toEqual({ documentNumber: 0.98, "rateBreakdown.0.vatAmount": 0.45, "rateBreakdown.1.netAmount": 0.62 });
    expect(version.payload.czkConversion?.rateBreakdown).toEqual([
      { rate: 21, netAmount: "2500.00", vatAmount: "525.00" },
      { rate: 12, netAmount: "1250.00", vatAmount: "0.00" },
    ]);
    expect(extraction.rateBreakdown).toHaveLength(4);
    expect(extraction.confidence?.["rateBreakdown.1.vatAmount"]).toBe(0.45);
  });
  it("omits only zero net and VAT rows when preparing corrections, retaining meaningful zero VAT", async () => {
    const document = await documentInReview();
    const payload: ExtractionPayload = {
      ...SAMPLE_EXTRACTION,
      rateBreakdown: [
        { rate: 0, netAmount: "0", vatAmount: "0,00" },
        { rate: 21, netAmount: "1000.00", vatAmount: "210.00" },
        { rate: 12, netAmount: "50.00", vatAmount: "0.00" },
        { rate: 12, netAmount: "-0.00", vatAmount: "00.00" },
      ],
      totals: { netAmount: "1050.00", vatAmount: "210.00", grossAmount: "1260.00" },
    };
    expect(await correctDocument(document.client, { ...document, basedOnVersion: 1, payload })).toEqual({ ok: true, value: { version: 2 } });
    const versions = await listExtractionVersions(document.client, document.companyId, document.documentId);
    expect(versions[1].payload.rateBreakdown).toEqual([
      { rate: 21, netAmount: "1000.00", vatAmount: "210.00" },
      { rate: 12, netAmount: "50.00", vatAmount: "0.00" },
    ]);
    expect(versions[1].payload.totals).toEqual({ netAmount: "1050.00", vatAmount: "210.00", grossAmount: "1260.00" });
    expect(versions[0].payload.rateBreakdown).toEqual(SAMPLE_EXTRACTION.rateBreakdown);
  });
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
    }, fakeExchangeRates(), fakeVatPayerRegistry());

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
      [1, { kind: "ai" }],
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
      rateBreakdown: [{ rate: 12, netAmount: "0.00", vatAmount: "0.00" }, { rate: 21, netAmount: "-100.00", vatAmount: "-21.00" }],
      totals: { netAmount: "-100.00", vatAmount: "-21.00", grossAmount: null },
    };

    expect(await correctDocument(client, { companyId, documentId, basedOnVersion: 1, payload: creditNote })).toEqual({
      ok: true,
      value: { version: 2 },
    });
    expect((await listExtractionVersions(client, companyId, documentId))[1].payload).toEqual(
      expect.objectContaining({
        documentType: "credit_note",
        originalDocumentNumber: "FV-2026-0001",
        rateBreakdown: [{ rate: 21, netAmount: "-100.00", vatAmount: "-21.00" }],
      }),
    );

    expect(
      await correctDocument(client, {
        companyId,
        documentId,
        basedOnVersion: 2,
        payload: { ...creditNote, originalDocumentNumber: null },
      }),
    ).toEqual({ ok: true, value: { version: 3 } });
    expect((await listExtractionVersions(client, companyId, documentId))[2].payload.originalDocumentNumber).toBeNull();
  });

  it("refuses a Credit Note whose entered amounts are not negative", async () => {
    const { client, companyId, documentId } = await documentInReview();
    const creditNote: ExtractionPayload = {
      ...SAMPLE_EXTRACTION,
      documentType: "credit_note",
      originalDocumentNumber: "FV-2026-0001",
    };

    expect(await correctDocument(client, {
      companyId,
      documentId,
      basedOnVersion: 1,
      payload: creditNote,
    })).toEqual({ ok: false, error: "invalid_credit_note_amount" });
  });

  it("refuses an all-zero Credit Note correction", async () => {
    const { client, companyId, documentId } = await documentInReview();
    const creditNote: ExtractionPayload = {
      ...SAMPLE_EXTRACTION,
      documentType: "credit_note",
      originalDocumentNumber: "FV-2026-0001",
      rateBreakdown: [{ rate: 21, netAmount: "0.00", vatAmount: "0.00" }],
      totals: { netAmount: "0.00", vatAmount: "0.00", grossAmount: "0.00" },
    };

    expect(await correctDocument(client, {
      companyId,
      documentId,
      basedOnVersion: 1,
      payload: creditNote,
    })).toEqual({ ok: false, error: "invalid_credit_note_amount" });
  });
});

describe("assigning an incoming Document to a Reporting Period", () => {
  it("shows the Import Date as the Prague calendar date of the Source File upload", async () => {
    const document = await documentInReview();
    // Test-only setup: 22:30 UTC on 30 September is already 1 October in Prague.
    const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
    await database.connect();
    try {
      await database.query(
        "update public.source_file set uploaded_at = '2026-09-30T22:30:00Z' where id = $1",
        [document.sourceFileId],
      );
    } finally {
      await database.end();
    }

    expect(
      (await getDocument(document.client, document.companyId, document.documentId))!.importDate,
    ).toBe("2026-10-01");
    expect(
      (await listCompanyDocuments(document.client, document.companyId))[0].importDate,
    ).toBe("2026-10-01");
  });

  it("stores a Deferred Claim and audits the change", async () => {
    const document = await documentInReview();
    const member = await companyMember(document);

    expect(
      await updateDocumentReporting(member.client, {
        companyId: document.companyId,
        documentId: document.documentId,
        claimedReportingPeriod: "2026-12",
      }),
    ).toEqual({ ok: true, value: null });

    expect(
      await getDocument(member.client, document.companyId, document.documentId),
    ).toEqual(expect.objectContaining({ claimedReportingPeriod: "2026-12" }));
    expect(
      (await listCompanyDocuments(member.client, document.companyId))[0].reportingPeriod,
    ).toBe("2026-12");
    expect(
      (await listAuditEvents(document.client, document.organizationId)).at(-1),
    ).toEqual(
      expect.objectContaining({
        action: "document.reporting_assignment_changed",
        actorUserId: member.userId,
        targetId: document.documentId,
        payload: {
          claimed_reporting_period: { from: null, to: "2026-12" },
        },
      }),
    );
  });

  it("returns the Document to its Tax Point Date's period when the Deferred Claim is cleared", async () => {
    const document = await documentInReview();
    const input = { companyId: document.companyId, documentId: document.documentId };
    await updateDocumentReporting(document.client, { ...input, claimedReportingPeriod: "2026-12" });

    expect(
      await updateDocumentReporting(document.client, { ...input, claimedReportingPeriod: null }),
    ).toEqual({ ok: true, value: null });
    expect(
      (await listCompanyDocuments(document.client, document.companyId))[0].reportingPeriod,
    ).toBe("2026-10");
  });

  it("refuses a Deferred Claim that is not later than the Tax Point Date's period", async () => {
    const document = await documentInReview();

    expect(
      await updateDocumentReporting(document.client, {
        companyId: document.companyId,
        documentId: document.documentId,
        claimedReportingPeriod: "2026-10",
      }),
    ).toEqual({ ok: false, error: "claimed_period_not_later" });
    expect(
      await getDocument(document.client, document.companyId, document.documentId),
    ).toEqual(expect.objectContaining({ claimedReportingPeriod: null }));
  });

  it("refuses a Deferred Claim for an outgoing Document", async () => {
    const document = await documentInReview(CORRECTED);

    expect(
      await updateDocumentReporting(document.client, {
        companyId: document.companyId,
        documentId: document.documentId,
        claimedReportingPeriod: "2026-12",
      }),
    ).toEqual({ ok: false, error: "incoming_required" });
  });
});

describe("approving and rejecting a Document", () => {
  it("refuses approval of an AI-proposed Credit Note with non-negative amounts", async () => {
    const document = await documentInReview({
      ...SAMPLE_EXTRACTION,
      documentType: "credit_note",
      originalDocumentNumber: "FV-2026-0001",
    });

    expect(await approveDocument(document.client, { ...document, version: 1 })).toEqual({
      ok: false,
      error: "invalid_credit_note_amount",
    });
  });

  it("refuses approval of an all-zero AI-proposed Credit Note", async () => {
    const document = await documentInReview({
      ...SAMPLE_EXTRACTION,
      documentType: "credit_note",
      originalDocumentNumber: "FV-2026-0001",
      rateBreakdown: [{ rate: 21, netAmount: "0.00", vatAmount: "0.00" }],
      totals: { netAmount: "0.00", vatAmount: "0.00", grossAmount: "0.00" },
    });

    expect(await approveDocument(document.client, { ...document, version: 1 })).toEqual({
      ok: false,
      error: "invalid_credit_note_amount",
    });
  });

  it("allows zero VAT on an otherwise negative self-assessed Credit Note", async () => {
    const document = await documentInReview({
      ...SAMPLE_EXTRACTION,
      documentType: "credit_note",
      originalDocumentNumber: "FV-2026-0001",
      proposedVatRegime: "domestic_reverse_charge",
      reverseChargeCode: "4",
      rateBreakdown: [{ rate: 21, netAmount: "-100.00", vatAmount: "0.00" }],
      totals: { netAmount: "-100.00", vatAmount: "0.00", grossAmount: "-100.00" },
    });

    expect(await approveDocument(document.client, { ...document, version: 1 })).toEqual({
      ok: true,
      value: null,
    });
  });

  it("refuses approval while Direction is unknown", async () => {
    const document = await documentInReview(UNDETECTED);

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

  it("records a User-set Direction as their Extraction Version, which clears the finding and allows approval", async () => {
    const document = await documentInReview(UNDETECTED);

    expect(
      await correctDocument(document.client, {
        ...document,
        basedOnVersion: 1,
        payload: { ...UNDETECTED, direction: "incoming" },
      }),
    ).toEqual({ ok: true, value: { version: 2 } });

    const versions = await listExtractionVersions(document.client, document.companyId, document.documentId);
    expect(versions[0].findings).toContainEqual({ field: "direction", severity: "error", code: "direction_unknown" });
    expect(versions[1]).toEqual(expect.objectContaining({
      author: { kind: "user", userId: document.userId },
      payload: expect.objectContaining({ direction: "incoming" }),
    }));
    expect(versions[1].findings).not.toContainEqual(expect.objectContaining({ code: "direction_unknown" }));
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

describe("checking Document totals", () => {
  it("warns about a gross total that differs from net plus VAT, showing the difference, and still allows approval", async () => {
    const document = await documentInReview();
    await correctDocument(document.client, {
      companyId: document.companyId,
      documentId: document.documentId,
      basedOnVersion: 1,
      payload: {
        ...SAMPLE_EXTRACTION,
        totals: { netAmount: "1000.00", vatAmount: "210.00", grossAmount: "1200.00" },
      },
    }, fakeExchangeRates(), fakeVatPayerRegistry());

    const versions = await listExtractionVersions(document.client, document.companyId, document.documentId);
    expect(versions[1].findings).toEqual([
      {
        field: "totals.grossAmount",
        severity: "warning",
        code: "total_gross_amount_mismatch",
        params: { difference: "10.00" },
      },
    ]);
    expect(await approveDocument(document.client, { ...document, version: 2 })).toEqual({ ok: true, value: null });
    const readiness = await getReportingPeriodReadiness(document.client, {
      companyId: document.companyId,
      period: "2026-10",
    });
    if (!readiness.ok) throw new Error(readiness.error);
    expect(readiness.value.blockers).toEqual([]);
    expect(readiness.value.warnings).toEqual([
      { code: "warning_finding", documentId: document.documentId, findingCode: "total_gross_amount_mismatch" },
    ]);
  });

  it("reads a historical gross-total error as a warning without rewriting its Extraction Version", async () => {
    const document = await documentInReview();
    // An old client recorded this finding before gross mismatches became warnings.
    const stored = await document.client.rpc("correct_document", {
      target_document_id: document.documentId,
      based_on_version: 1,
      payload: {
        ...SAMPLE_EXTRACTION,
        totals: { netAmount: "1000.00", vatAmount: "210.00", grossAmount: "1200.00" },
      },
      findings: [{ field: "totals.grossAmount", severity: "error", code: "total_gross_amount_mismatch" }],
    });
    expect(stored.error).toBeNull();
    const versions = await listExtractionVersions(document.client, document.companyId, document.documentId);
    expect(versions[1].findings).toEqual([{
      field: "totals.grossAmount", severity: "warning", code: "total_gross_amount_mismatch",
      params: { difference: "10.00" },
    }]);
    expect(await approveDocument(document.client, { ...document, version: 2 })).toEqual({ ok: true, value: null });
    const readiness = await getReportingPeriodReadiness(document.client, {
      companyId: document.companyId, period: "2026-10",
    });
    if (!readiness.ok) throw new Error(readiness.error);
    expect(readiness.value.blockers).toEqual([]);
    expect(readiness.value.warnings).toEqual([{
      code: "warning_finding", documentId: document.documentId, findingCode: "total_gross_amount_mismatch",
    }]);
    expect((await generateVatReport(document.client, {
      companyId: document.companyId, period: "2026-10",
    })).ok).toBe(true);
    expect((await getVatReport(document.client, document.companyId, "2026-10"))?.finalization).toEqual({
      blockerCount: 0, warningCount: 1, rejectedDocumentCount: 0,
    });
  });

  it.each([
    ["net", { netAmount: "1100.00", vatAmount: "210.00", grossAmount: "1310.00" }],
    ["VAT", { netAmount: "1000.00", vatAmount: "200.00", grossAmount: "1200.00" }],
  ])("refuses approval when the %s total disagrees with the Rate Breakdown", async (_name, totals) => {
    const document = await documentInReview();
    await correctDocument(document.client, {
      companyId: document.companyId,
      documentId: document.documentId,
      basedOnVersion: 1,
      payload: { ...SAMPLE_EXTRACTION, totals },
    });
    expect(await approveDocument(document.client, { ...document, version: 2 })).toEqual({
      ok: false, error: "rate_breakdown_totals_mismatch",
    });
    expect((await listDocuments(document.client, document.companyId, document.sourceFileId))[0].status)
      .toBe("needs_review");
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
    const b = await provisionedUser("Organization B");

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
    const b = await provisionedUser("Organization B");

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


it("offers only later generated periods for a Deferred Claim", async () => {
  const document = await documentInReview();
  expect(await listDeferredClaimPeriods(document.client, document.companyId, document.documentId))
    .toEqual(["2026-11", "2026-12"]);
});


it("refuses a Deferred Claim more than three years after the Tax Point Date", async () => {
  const document = await documentInReview();
  const { setCurrentReportingYear } = await import("@/application/companies");
  await setCurrentReportingYear(document.client, { companyId: document.companyId, year: 2030, filingFrequency: "monthly" });
  expect(await updateDocumentReporting(document.client, { companyId: document.companyId, documentId: document.documentId, claimedReportingPeriod: "2030-01" }))
    .toEqual({ ok: false, error: "invalid_reporting_period" });
  expect(await listDeferredClaimPeriods(document.client, document.companyId, document.documentId)).not.toContain("2030-01");
});


it("refuses the Deferred Claim migration before it moves a locked legacy assignment", async () => {
  const document = await documentInReview();
  const { setCurrentReportingYear } = await import("@/application/companies");
  const { generateVatReport, finalizeVatReport } = await import("@/application/vat-reports");
  expect(await setCurrentReportingYear(document.client, { companyId: document.companyId, year: 2030, filingFrequency: "monthly" })).toEqual({ ok: true, value: null });
  const period = { companyId: document.companyId, period: "2030-01" };
  expect((await generateVatReport(document.client, period)).ok).toBe(true);
  expect(await finalizeVatReport(document.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
  const original = readFileSync("supabase/migrations/20261120120000_tax_point_date_reporting_period.sql", "utf8");
  const start = original.indexOf("create function private.document_reporting_period(");
  const end = original.indexOf("revoke execute on function private.document_reporting_period", start);
  const oldFunction = original.slice(start, end).replace("create function", "create or replace function");
  const migration = readFileSync("supabase/migrations/20261120130000_deferred_claim.sql", "utf8");
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("begin");
    await database.query(oldFunction);
    // Test-only pre-upgrade fixture, isolated in this transaction.
    await database.query("alter table public.document disable trigger document_period_lock");
    await database.query("update public.document set claimed_reporting_period = '2030-01' where id = $1", [document.documentId]);
    await database.query("alter table public.document enable trigger document_period_lock");
    await expect(database.query(migration)).rejects.toMatchObject({ hint: "locked_legacy_deferred_claim" });
  } finally {
    await database.query("rollback");
    await database.end();
  }
  expect((await listCompanyDocuments(document.client, document.companyId))[0].reportingPeriod).toBe("2026-10");
});
