import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { correctDocument, saveAndApproveDocument, listExtractionVersions } from "@/application/documents";
import { getDocumentReview } from "@/application/document-review";
import { administratorWithCompany } from "./support/fixtures";
import { createConfirmedManualDocument } from "./support/claim-eligibility";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";

const malformed = [
  { field: "rateBreakdown.0.netAmount", change: { rateBreakdown: [{ rate: 21, netAmount: "abc", vatAmount: "210.00" }] } },
  { field: "rateBreakdown.0.vatAmount", change: { rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "abc" }] } },
  { field: "totals.netAmount", change: { totals: { ...SAMPLE_EXTRACTION.totals, netAmount: "abc" } } },
  { field: "totals.vatAmount", change: { totals: { ...SAMPLE_EXTRACTION.totals, vatAmount: "abc" } } },
  { field: "totals.grossAmount", change: { totals: { ...SAMPLE_EXTRACTION.totals, grossAmount: "abc" } } },
] satisfies { field: string; change: Partial<ExtractionPayload> }[];

const remaining = [
  { name: "Document type", field: "documentType", code: "invalid_choice", change: { documentType: "invalid" as ExtractionPayload["documentType"] } },
  { name: "Direction", field: "direction", code: "invalid_choice", change: { direction: "invalid" as ExtractionPayload["direction"] } },
  { name: "VAT Regime", field: "proposedVatRegime", code: "invalid_choice", change: { proposedVatRegime: "invalid" as ExtractionPayload["proposedVatRegime"] } },
  { name: "non-numeric rate", field: "rateBreakdown.0.rate", code: "invalid_rate", change: { rateBreakdown: [{ ...SAMPLE_EXTRACTION.rateBreakdown[0], rate: NaN }] } },
  { name: "negative rate", field: "rateBreakdown.0.rate", code: "invalid_rate", change: { rateBreakdown: [{ ...SAMPLE_EXTRACTION.rateBreakdown[0], rate: -1 }] } },
  { name: "rate above 100", field: "rateBreakdown.0.rate", code: "invalid_rate", change: { rateBreakdown: [{ ...SAMPLE_EXTRACTION.rateBreakdown[0], rate: 101 }] } },
  { name: "infinite rate", field: "rateBreakdown.0.rate", code: "invalid_rate", change: { rateBreakdown: [{ ...SAMPLE_EXTRACTION.rateBreakdown[0], rate: Infinity }] } },
  { name: "issue date", field: "issueDate", code: "invalid_date", change: { issueDate: "2026-02-30" } },
  { name: "Tax Point Date", field: "taxPointDate", code: "invalid_date", change: { taxPointDate: "2026-02-30" } },
  { name: "due date", field: "dueDate", code: "invalid_date", change: { dueDate: "abc" } },
  { name: "missing Tax Point Date", field: "taxPointDate", code: "tax_point_date_required", change: { taxPointDate: null } },
  { name: "empty Tax Point Date", field: "taxPointDate", code: "tax_point_date_required", change: { taxPointDate: "" } },
  { name: "currency", field: "currency", code: "invalid_currency", change: { currency: "Kč" } },
  { name: "supplier country", field: "supplier.country", code: "invalid_country", change: { supplier: { ...SAMPLE_EXTRACTION.supplier, country: "CZE" } } },
  { name: "customer country", field: "customer.country", code: "invalid_country", change: { customer: { ...SAMPLE_EXTRACTION.customer, country: "USA" } } },
  { name: "reverse-charge code", field: "reverseChargeCode", code: "invalid_reverse_charge_code", change: { reverseChargeCode: "letters" } },
] satisfies { name: string; field: string; code: string; change: Partial<ExtractionPayload> }[];

for (const intent of ["draft", "approve"] as const) {
  const command = intent === "draft" ? correctDocument : saveAndApproveDocument;
  it.each(malformed)(`${intent} identifies malformed $field without saving any part of the submitted correction`, async ({ field, change }) => {
    const owner = await administratorWithCompany();
    const created = await createConfirmedManualDocument(owner.client, { companyId: owner.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    const target = { companyId: owner.companyId, documentId: created.value.id };
    const before = await listExtractionVersions(owner.client, target.companyId, target.documentId);
    const payload = { ...before[0].payload, documentNumber: "UNSAVED-MALFORMED", ...change };
    expect(await command(owner.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload }, undefined,
      { async check() { throw new Error("Malformed input must refuse before registry work"); } }))
      .toEqual({ ok: false, error: "invalid_amount", findings: [{ field, severity: "error", code: "invalid_amount" }] });
    expect(await listExtractionVersions(owner.client, target.companyId, target.documentId)).toEqual(before);
    expect((await getDocumentReview(owner.client, target))?.document.status).toBe("needs_review");
  });

  it(`${intent} addresses every malformed amount using submitted row identities after an empty row`, async () => {
    const owner = await administratorWithCompany();
    const created = await createConfirmedManualDocument(owner.client, { companyId: owner.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    const target = { companyId: owner.companyId, documentId: created.value.id };
    const before = await listExtractionVersions(owner.client, target.companyId, target.documentId);
    const payload = { ...before[0].payload, sourceRateRows: [2, 7], rateBreakdown: [
      { rate: 12, netAmount: "0.00", vatAmount: "0.00" },
      { rate: 21, netAmount: "abc", vatAmount: "1,234" },
    ], totals: { netAmount: "abc", vatAmount: "210.00", grossAmount: "?" } };
    expect(await command(owner.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload }, undefined, fakeVatPayerRegistry()))
      .toEqual({ ok: false, error: "invalid_amount", findings: [
        { field: "rateBreakdown.7.netAmount", severity: "error", code: "invalid_amount" },
        { field: "rateBreakdown.7.vatAmount", severity: "error", code: "invalid_amount" },
        { field: "totals.netAmount", severity: "error", code: "invalid_amount" },
        { field: "totals.grossAmount", severity: "error", code: "invalid_amount" },
      ] });
    expect(await listExtractionVersions(owner.client, target.companyId, target.documentId)).toEqual(before);
  });

  it.each(remaining)(`${intent} addresses invalid $name at its actual field`, async ({ field, code, change }) => {
    const owner = await administratorWithCompany();
    const created = await createConfirmedManualDocument(owner.client, { companyId: owner.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    const target = { companyId: owner.companyId, documentId: created.value.id };
    const before = await listExtractionVersions(owner.client, target.companyId, target.documentId);
    expect(await command(owner.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...before[0].payload, ...change } }, undefined,
      { async check() { throw new Error("Parser refusal must precede external preparation"); } }))
      .toEqual({ ok: false, error: code, findings: [{ field, severity: "error", code }] });
    expect(await listExtractionVersions(owner.client, target.companyId, target.documentId)).toEqual(before);
  });

  it(`${intent} returns all mixed parser errors at sparse submitted fields while retaining the first refusal`, async () => {
    const owner = await administratorWithCompany();
    const created = await createConfirmedManualDocument(owner.client, { companyId: owner.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    const target = { companyId: owner.companyId, documentId: created.value.id };
    const before = await listExtractionVersions(owner.client, target.companyId, target.documentId);
    const payload = { ...before[0].payload, documentType: "invalid" as ExtractionPayload["documentType"], direction: "invalid" as ExtractionPayload["direction"],
      proposedVatRegime: "invalid" as ExtractionPayload["proposedVatRegime"], sourceRateRows: [2, 7], rateBreakdown: [
        { rate: 12, netAmount: "0.00", vatAmount: "0.00" }, { rate: NaN, netAmount: "abc", vatAmount: "210.00" },
      ], issueDate: "2026-02-30", taxPointDate: null, dueDate: "abc", currency: "Kč", reverseChargeCode: "letters",
      supplier: { ...SAMPLE_EXTRACTION.supplier, country: "CZE" }, customer: { ...SAMPLE_EXTRACTION.customer, country: "USA" },
      totals: { ...SAMPLE_EXTRACTION.totals, grossAmount: "abc" } };
    expect(await command(owner.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload }))
      .toEqual({ ok: false, error: "tax_point_date_required", findings: [
        { field: "taxPointDate", severity: "error", code: "tax_point_date_required" },
        { field: "documentType", severity: "error", code: "invalid_choice" },
        { field: "direction", severity: "error", code: "invalid_choice" },
        { field: "proposedVatRegime", severity: "error", code: "invalid_choice" },
        { field: "rateBreakdown.7.netAmount", severity: "error", code: "invalid_amount" },
        { field: "totals.grossAmount", severity: "error", code: "invalid_amount" },
        { field: "rateBreakdown.7.rate", severity: "error", code: "invalid_rate" },
        { field: "issueDate", severity: "error", code: "invalid_date" },
        { field: "dueDate", severity: "error", code: "invalid_date" },
        { field: "currency", severity: "error", code: "invalid_currency" },
        { field: "reverseChargeCode", severity: "error", code: "invalid_reverse_charge_code" },
        { field: "supplier.country", severity: "error", code: "invalid_country" },
        { field: "customer.country", severity: "error", code: "invalid_country" },
      ] });
    expect(await listExtractionVersions(owner.client, target.companyId, target.documentId)).toEqual(before);
  });

  it(`${intent} preserves operation, DUZP and choice refusal precedence ahead of malformed money`, async () => {
    const owner = await administratorWithCompany();
    const created = await createConfirmedManualDocument(owner.client, { companyId: owner.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    const input = { companyId: owner.companyId, documentId: created.value.id, basedOnVersion: 1, requestId: crypto.randomUUID(),
      payload: { ...SAMPLE_EXTRACTION, totals: { ...SAMPLE_EXTRACTION.totals, grossAmount: "abc" } } };
    expect(await command(owner.client, { ...input, requestId: "invalid" })).toEqual({ ok: false, error: "stale_version" });
    expect(await command(owner.client, { ...input, payload: { ...input.payload, taxPointDate: null } })).toEqual({ ok: false, error: "tax_point_date_required", findings: [
      { field: "taxPointDate", severity: "error", code: "tax_point_date_required" }, { field: "totals.grossAmount", severity: "error", code: "invalid_amount" },
    ] });
    expect(await command(owner.client, { ...input, payload: { ...input.payload, schemaVersion: 99 as 1 } })).toEqual({ ok: false, error: "invalid_choice",
      findings: [{ field: "totals.grossAmount", severity: "error", code: "invalid_amount" }],
    });
    expect(await command(owner.client, { ...input, payload: { ...SAMPLE_EXTRACTION, schemaVersion: 99 as 1 } })).toEqual({ ok: false, error: "invalid_choice" });
  });
}
