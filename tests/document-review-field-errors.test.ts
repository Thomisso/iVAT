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

  it(`${intent} preserves operation, DUZP and choice refusal precedence ahead of malformed money`, async () => {
    const owner = await administratorWithCompany();
    const created = await createConfirmedManualDocument(owner.client, { companyId: owner.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    const input = { companyId: owner.companyId, documentId: created.value.id, basedOnVersion: 1, requestId: crypto.randomUUID(),
      payload: { ...SAMPLE_EXTRACTION, totals: { ...SAMPLE_EXTRACTION.totals, grossAmount: "abc" } } };
    expect(await command(owner.client, { ...input, requestId: "invalid" })).toEqual({ ok: false, error: "stale_version" });
    expect(await command(owner.client, { ...input, payload: { ...input.payload, taxPointDate: null } })).toEqual({ ok: false, error: "tax_point_date_required" });
    expect(await command(owner.client, { ...input, payload: { ...input.payload, schemaVersion: 99 as 1 } })).toEqual({ ok: false, error: "invalid_choice" });
  });
}
