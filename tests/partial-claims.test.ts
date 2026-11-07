import { uploadSourceFile } from "@/application/source-files";
import { listDocuments } from "@/application/documents";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { expect, it } from "vitest";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { createManualDocument, saveAndApproveDocument, listExtractionVersions, returnDocumentToReview, correctDocument, approveDocument, getDocument } from "@/application/documents";
import { generateVatReport, getVatReport, finalizeVatReport } from "@/application/vat-reports";
import { getDocumentReview } from "@/application/document-review";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany, companyMember, assignAiConfigurationFixture } from "./support/fixtures";

const full = {
  ...SAMPLE_EXTRACTION,
  rateBreakdown: [{ rate: 21, netAmount: "12000.00", vatAmount: "2520.00" }],
  totals: { netAmount: "12000.00", vatAmount: "2520.00", grossAmount: "14520.00" },
};
const partialClaim = { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "6000.00", vatAmount: "1260.00" }] };
const registry = fakeVatPayerRegistry();

it("a Company User saves and approves selected supplies while retaining full source history and the saved B.2 report", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const created = await createManualDocument(user.client, { companyId: company.companyId, payload: full }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await saveAndApproveDocument(user.client, { ...input, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...full, partialClaim } }, undefined, registry))
    .toEqual({ ok: true, value: { version: 2 } });
  const versions = await listExtractionVersions(user.client, input.companyId, input.documentId);
  expect(versions).toHaveLength(2);
  expect(versions[0].payload.partialClaim).toBeUndefined();
  expect(versions[1].payload).toMatchObject({ rateBreakdown: full.rateBreakdown, totals: full.totals, partialClaim });
  expect((await getDocumentReview(user.client, input))?.shown?.payload.partialClaim).toMatchObject(partialClaim);
  expect((await generateVatReport(user.client, { companyId: input.companyId, period: "2026-10" })).ok).toBe(true);
  const saved = await getVatReport(user.client, input.companyId, "2026-10");
  expect(saved?.documents[0].payload?.partialClaim).toMatchObject(partialClaim);
  expect(saved?.result.vatReturn.find(line => line.line === "40")).toMatchObject({ netAmount: "6000.00", vatAmount: "1260.00" });
  expect(saved?.result.controlStatement).toMatchObject([{ section: "B.2", rateBreakdown: [{ netAmount: "6000.00", vatAmount: "1260.00" }] }]);
  expect(await finalizeVatReport(company.client, { companyId: input.companyId, period: "2026-10", confirmed: true })).toEqual({ ok: true, value: null });
  expect(await returnDocumentToReview(user.client, input)).toEqual({ ok: false, error: "period_locked" });
  expect(await correctDocument(user.client, { ...input, basedOnVersion: 2, payload: { ...versions[1].payload, partialClaim: null } }, undefined, registry))
    .toMatchObject({ ok: false, error: "not_in_review" });
  expect(await getVatReport(user.client, input.companyId, "2026-10")).toEqual(saved);

});

it.each([
  { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "13000.00", vatAmount: "2730.00" }] },
  { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "6000.00", vatAmount: "1200.00" }] },
  { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "6000.00", vatAmount: null }] },
  { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "0.00", vatAmount: "0.00" }] },
  { ...partialClaim, confirmed: false },
])("the database refuses an invalid selected claim even with forged empty findings (%j)", async (claim) => {
  const company = await administratorWithCompany();
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: full }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const payload = { ...full, partialClaim: claim };
  const changed = await company.client.rpc("correct_document", { target_document_id: created.value.id, based_on_version: 1, payload, findings: [] });
  expect(changed.error).toBeNull();
  const approved = await company.client.rpc("approve_document", { target_document_id: created.value.id, reviewed_version: 2 });
  expect(approved.error).toMatchObject({ code: "P0001", hint: "document_validation_failed" });
  expect((await getDocument(company.client, company.companyId, created.value.id))?.status).toBe("needs_review");
  expect((await getDocumentReview(company.client, { companyId: company.companyId, documentId: created.value.id }))?.shownFindings)
    .toEqual(expect.arrayContaining([{ field: "partialClaim", severity: "error", code: "partial_claim_invalid" }]));
});

it("preserves a prior selection after changed originals until human reconfirmation, and keeps the old report", async () => {
  const company = await administratorWithCompany();
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: { ...full, partialClaim } }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await approveDocument(company.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
  await generateVatReport(company.client, { companyId: input.companyId, period: "2026-10" });
  const saved = await getVatReport(company.client, input.companyId, "2026-10");
  expect(await returnDocumentToReview(company.client, input)).toEqual({ ok: true, value: null });
  const previous = (await listExtractionVersions(company.client, input.companyId, input.documentId))[0].payload;
  const changed = { ...previous, rateBreakdown: [{ rate: 21, netAmount: "14000.00", vatAmount: "2940.00" }], totals: { netAmount: "14000.00", vatAmount: "2940.00", grossAmount: "16940.00" } };
  expect(await correctDocument(company.client, { ...input, basedOnVersion: 1, payload: changed }, undefined, registry)).toEqual({ ok: true, value: { version: 2 } });
  const current = (await listExtractionVersions(company.client, input.companyId, input.documentId))[1].payload;
  expect(current.partialClaim).toMatchObject({ ...partialClaim, confirmed: false });
  expect(await approveDocument(company.client, { ...input, version: 2 })).toMatchObject({ ok: false, error: "document_validation_failed" });
  expect(await getVatReport(company.client, input.companyId, "2026-10")).toEqual(saved);
  const renewed = { ...current, partialClaim: { ...current.partialClaim!, confirmed: true, basis: {
    documentType: "invoice" as const, direction: "incoming" as const, currency: "CZK", proposedVatRegime: "domestic" as const, taxPointDate: "2026-10-01",
    rateBreakdown: [{ rate: 21, netAmount: "14000.00", vatAmount: "2940.00" }],
    totals: { netAmount: "14000.00", vatAmount: "2940.00", grossAmount: "16940.00" },
  } } };
  expect(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 2, requestId: crypto.randomUUID(), payload: renewed }, undefined, registry))
    .toEqual({ ok: true, value: { version: 3 } });
  expect(await returnDocumentToReview(company.client, input)).toEqual({ ok: true, value: null });
  expect(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 3, requestId: crypto.randomUUID(), payload: { ...renewed, partialClaim: null } }, undefined, registry))
    .toEqual({ ok: true, value: { version: 4 } });
  const resolved = (await listExtractionVersions(company.client, input.companyId, input.documentId))[3].payload;
  expect(resolved.partialClaim).toBeUndefined();
  expect(await getVatReport(company.client, input.companyId, "2026-10")).toEqual(saved);
});


it("AI cannot author a Partial Claim even when its returned payload contains human-selection metadata", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker(fakeAiProvider({ extract: () => ({ ...full, partialClaim: { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "6000.00", vatAmount: "1100.00" }] } }) }));
  expect((await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai })).ok).toBe(true);
  const uploaded = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(company.client, company.companyId, uploaded.value.id);
  const [version] = await listExtractionVersions(company.client, company.companyId, document.id);
  expect(version.author).toEqual({ kind: "ai" });
  expect(version.payload.partialClaim).toBeUndefined();
  expect(version.findings.some(finding => finding.code === "partial_claim_invalid")).toBe(false);
  expect(version.payload).toMatchObject({ rateBreakdown: full.rateBreakdown, totals: full.totals });
});
