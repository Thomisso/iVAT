import { createConfirmedManualDocument, setOctoberImportFixture } from "./support/claim-eligibility";
import { uploadSourceFile } from "@/application/source-files";
import { listDocuments } from "@/application/documents";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { expect, it } from "vitest";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { saveAndApproveDocument, listExtractionVersions, returnDocumentToReview, correctDocument, approveDocument, getDocument, reprocessDocument } from "@/application/documents";
import { generateVatReport, getVatReport, finalizeVatReport } from "@/application/vat-reports";
import { getDocumentReview } from "@/application/document-review";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany, companyMember, assignAiConfigurationFixture } from "./support/fixtures";
import { fakeExchangeRates } from "@/cnb/fake";
import { listAuditEvents } from "@/application/audit";

const full = {
  ...SAMPLE_EXTRACTION,
  rateBreakdown: [{ rate: 21, netAmount: "12000.00", vatAmount: "2520.00" }],
  totals: { netAmount: "12000.00", vatAmount: "2520.00", grossAmount: "14520.00" },
};
const partialClaim = { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "6000.00", vatAmount: "1260.00" }] };
const registry = fakeVatPayerRegistry();

it.each([
  { method: "section75" }, { method: "section76" }, { periods: ["2026-10", "2026-11"] },
])("direct authenticated claims cannot encode an unsupported statutory method or multiple periods (%j)", async extra => {
  const company = await administratorWithCompany();
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: full }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const corrected = await company.client.rpc("correct_document", { target_document_id: created.value.id, based_on_version: 1,
    payload: { ...full, partialClaim: { ...partialClaim, ...extra } }, findings: [] });
  expect(corrected.error).toBeNull();
  expect((await company.client.rpc("approve_document", { target_document_id: created.value.id, reviewed_version: 2 })).error)
    .toMatchObject({ code: "P0001", hint: "document_validation_failed" });
  expect((await getDocument(company.client, company.companyId, created.value.id))?.status).toBe("needs_review");
});

it("retains a human-confirmed zero choice in history and a locked report without any Control Statement row", async () => {
  const company = await administratorWithCompany();
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: full }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const claim = { confirmed: true, zeroConfirmed: true, rateBreakdown: [{ rate: 21, netAmount: "0.00", vatAmount: "0.00" }] };
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...full, partialClaim: claim } }, undefined, registry))
    .toEqual({ ok: true, value: { version: 2 } });
  expect((await generateVatReport(company.client, { companyId: input.companyId, period: "2026-10" })).ok).toBe(true);
  const saved = await getVatReport(company.client, input.companyId, "2026-10");
  expect(saved?.documents[0].payload).toMatchObject({ rateBreakdown: full.rateBreakdown, totals: full.totals, partialClaim: claim });
  expect(saved?.result.controlStatement).toEqual([]);
  expect(saved?.result.totals.inputVat).toBe("0.00");
  expect(saved?.result.excludedDocuments).toEqual([]);
  expect(await finalizeVatReport(company.client, { companyId: input.companyId, period: "2026-10", confirmed: true })).toEqual({ ok: true, value: null });
  expect(await returnDocumentToReview(company.client, input)).toEqual({ ok: false, error: "period_locked" });
  expect(await getVatReport(company.client, input.companyId, "2026-10")).toEqual(saved);
});

it("uses the same stored quoted-unit fixing for foreign full amounts and selected supplies", async () => {
  const company = await administratorWithCompany();
  const rates = fakeExchangeRates("2434.50", 100);
  const source = { ...full, currency: "EUR", rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "210.00" }],
    totals: { netAmount: "1000.00", vatAmount: "210.00", grossAmount: "1210.00" } };
  const claim = { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "200.00", vatAmount: "42.00" }] };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: source }, rates, registry);
  if (!created.ok) throw new Error(created.error);
  expect(await saveAndApproveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, basedOnVersion: 1,
    requestId: crypto.randomUUID(), payload: { ...source, partialClaim: claim } }, rates, registry)).toEqual({ ok: true, value: { version: 2 } });
  const versions = await listExtractionVersions(company.client, company.companyId, created.value.id);
  expect(versions[1].payload).toMatchObject({ currency: "EUR", rateBreakdown: source.rateBreakdown, totals: source.totals, partialClaim: claim,
    czkConversion: { rate: "2434.50", unit: 100, originalCurrency: "EUR", totals: { netAmount: "24345.00", vatAmount: "5112.45", grossAmount: "29457.45" } } });
  expect((await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" })).ok).toBe(true);
  const report = await getVatReport(company.client, company.companyId, "2026-10");
  expect(report?.result.vatReturn.find(line => line.line === "40")).toMatchObject({ netAmount: "4869.00", vatAmount: "1022.49" });
  expect(report?.result.controlStatement).toMatchObject([{ section: "B.2", rateBreakdown: [{ netAmount: "4869.00", vatAmount: "1022.49" }] }]);
});

it("saves and approves mixed-rate selected supplies and retains the whole source in the stored report", async () => {
  const company = await administratorWithCompany();
  const source = { ...full,
    rateBreakdown: [{ rate: 21, netAmount: "12000.10", vatAmount: "2520.02" }, { rate: 12, netAmount: "2000.20", vatAmount: "240.02" }],
    totals: { netAmount: "14000.30", vatAmount: "2760.04", grossAmount: "16760.34" },
  };
  const claim = { confirmed: true, rateBreakdown: [
    { rate: 21, netAmount: "6000.05", vatAmount: "1260.01" }, { rate: 12, netAmount: "1000.10", vatAmount: "120.01" },
  ] };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: source }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  expect(await saveAndApproveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, basedOnVersion: 1,
    requestId: crypto.randomUUID(), payload: { ...source, partialClaim: claim } }, undefined, registry)).toEqual({ ok: true, value: { version: 2 } });
  expect((await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" })).ok).toBe(true);
  const saved = await getVatReport(company.client, company.companyId, "2026-10");
  expect(saved?.documents[0].payload).toMatchObject({ rateBreakdown: source.rateBreakdown, totals: source.totals, partialClaim: claim });
  expect(saved?.result.vatReturn.filter(line => line.documentIds.length)).toMatchObject([
    { line: "40", netAmount: "6000.05", vatAmount: "1260.01" }, { line: "41", netAmount: "1000.10", vatAmount: "120.01" },
  ]);
  expect(saved?.result.totals.inputVat).toBe("1380.02");
  expect(saved?.result.controlStatement).toMatchObject([{ section: "B.2" }]);
});

it("a Company User saves and approves selected supplies while retaining full source history and the saved B.2 report", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const created = await createConfirmedManualDocument(user.client, { companyId: company.companyId, payload: full }, undefined, registry);
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
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: full }, undefined, registry);
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
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: { ...full, partialClaim } }, undefined, registry);
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
  const fullChoice = { ...input, basedOnVersion: 3, requestId: crypto.randomUUID(), payload: { ...renewed, partialClaim: null } };
  expect(await saveAndApproveDocument(company.client, fullChoice, undefined, registry))
    .toEqual({ ok: true, value: { version: 4 } });
  expect(await saveAndApproveDocument(company.client, fullChoice, undefined, registry)).toEqual({ ok: true, value: { version: 4 } });
  const resolved = (await listExtractionVersions(company.client, input.companyId, input.documentId))[3].payload;
  expect(resolved.partialClaim).toBeUndefined();
  expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "document.partial_claim_cleared"))
    .toEqual([expect.objectContaining({ actorUserId: company.userId, targetId: input.documentId, payload: { previousVersion: 3, version: 4 } })]);
  expect(await getVatReport(company.client, input.companyId, "2026-10")).toEqual(saved);
});

it.each([
  { name: "outgoing", source: { direction: "outgoing" } },
  { name: "domestic reverse charge", source: { proposedVatRegime: "domestic_reverse_charge", reverseChargeCode: "4" } },
  { name: "EU goods", source: { proposedVatRegime: "eu_acquisition_of_goods", supplier: { ...full.supplier, vatId: "DE123456789", country: "DE" } } },
  { name: "EU services", source: { proposedVatRegime: "eu_received_service", supplier: { ...full.supplier, vatId: "DE123456789", country: "DE" } } },
  { name: "Credit Note", source: { documentType: "credit_note", originalDocumentNumber: "ORIGINAL", rateBreakdown: [{ rate: 21, netAmount: "-12000.00", vatAmount: "-2520.00" }],
    totals: { netAmount: "-12000.00", vatAmount: "-2520.00", grossAmount: "-14520.00" } } },
  { name: "original arithmetic mismatch", source: { totals: { netAmount: "11999.00", vatAmount: "2520.00", grossAmount: "14519.00" } } },
  { name: "missing foreign fixing", source: { currency: "EUR" } },
])("authenticated RPC refuses $name partial approval despite forged findings", async ({ source }) => {
  const company = await administratorWithCompany();
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: full }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  expect((await company.client.rpc("correct_document", { target_document_id: created.value.id, based_on_version: 1,
    payload: { ...full, ...source, partialClaim }, findings: [] })).error).toBeNull();
  expect((await company.client.rpc("approve_document", { target_document_id: created.value.id, reviewed_version: 2 })).error)
    .toMatchObject({ code: "P0001", hint: source.currency === "EUR" ? "currency_conversion_required" : "document_validation_failed" });
  expect((await getDocument(company.client, company.companyId, created.value.id))?.status).toBe("needs_review");
});

it.each([
  { name: "currency", changed: { currency: "EUR" } },
  { name: "Direction", changed: { direction: "outgoing" as const } },
  { name: "VAT Regime", changed: { proposedVatRegime: "domestic_reverse_charge" as const, reverseChargeCode: "4" } },
  { name: "Document type", changed: { documentType: "credit_note" as const, originalDocumentNumber: "ORIGINAL" } },
  { name: "VAT rate", changed: { rateBreakdown: [{ rate: 12, netAmount: "12000.00", vatAmount: "1440.00" }],
    totals: { netAmount: "12000.00", vatAmount: "1440.00", grossAmount: "13440.00" } } },
])("changing $name preserves the prior selection for comparison and never confirms or rescales it", async ({ changed }) => {
  const company = await administratorWithCompany();
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: { ...full, partialClaim } }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  const [old] = await listExtractionVersions(company.client, input.companyId, input.documentId);
  // Deliberate omission cannot erase an existing human choice.
  expect(await correctDocument(company.client, { ...input, basedOnVersion: 1, payload: { ...full, ...changed } }, fakeExchangeRates(), registry))
    .toEqual({ ok: true, value: { version: 2 } });
  const versions = await listExtractionVersions(company.client, input.companyId, input.documentId);
  expect(versions[0]).toEqual(old);
  expect(versions[1].payload.partialClaim).toEqual({ ...old.payload.partialClaim, confirmed: false });
  expect((await getDocumentReview(company.client, input))?.shownFindings).toContainEqual({ field: "partialClaim", severity: "error", code: "partial_claim_invalid" });
  expect((await company.client.rpc("approve_document", { target_document_id: input.documentId, reviewed_version: 2 })).error).not.toBeNull();
});


it("AI cannot author a Partial Claim even when its returned payload contains human-selection metadata", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker(fakeAiProvider({ extract: () => ({ ...full, partialClaim: { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "6000.00", vatAmount: "1100.00" }] } }) }));
  expect((await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai })).ok).toBe(true);
  const uploaded = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportFixture(uploaded.value.id);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(company.client, company.companyId, uploaded.value.id);
  const [version] = await listExtractionVersions(company.client, company.companyId, document.id);
  expect(version.author).toEqual({ kind: "ai" });
  expect(version.payload.partialClaim).toBeUndefined();
  expect(version.findings.some(finding => finding.code === "partial_claim_invalid")).toBe(false);
  expect(version.payload).toMatchObject({ rateBreakdown: full.rateBreakdown, totals: full.totals });
});

it.each([
  { name: "selected supplies", claim: { confirmed: true, rateBreakdown: [
    { rate: 21, netAmount: "200.00", vatAmount: "42.00" }, { rate: 12, netAmount: "100.00", vatAmount: "12.00" },
  ] } },
  { name: "confirmed zero", claim: { confirmed: true, zeroConfirmed: true, rateBreakdown: [
    { rate: 21, netAmount: "0.00", vatAmount: "0.00" }, { rate: 12, netAmount: "0.00", vatAmount: "0.00" },
  ] } },
])("new AI retains every foreign mixed-rate $name choice unconfirmed until deliberate review, preserving the prior report", async ({ claim }) => {
  const company = await administratorWithCompany();
  const rates = fakeExchangeRates("24.345");
  let source = { ...full, currency: "EUR", rateBreakdown: [
    { rate: 21, netAmount: "1000.00", vatAmount: "210.00" }, { rate: 12, netAmount: "1000.00", vatAmount: "120.00" },
  ], totals: { netAmount: "2000.00", vatAmount: "330.00", grossAmount: "2330.00" } };
  const worker = testWorker(fakeAiProvider({ extract: () => ({ ...source, partialClaim: { confirmed: true, rateBreakdown: source.rateBreakdown } }) }), registry, rates);
  await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const uploaded = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportFixture(uploaded.value.id);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(company.client, company.companyId, uploaded.value.id);
  const input = { companyId: company.companyId, documentId: document.id };
  expect(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...source, partialClaim: claim } }, rates, registry))
    .toEqual({ ok: true, value: { version: 2 } });
  expect((await generateVatReport(company.client, { companyId: input.companyId, period: "2026-10" })).ok).toBe(true);
  const oldVersions = await listExtractionVersions(company.client, input.companyId, input.documentId);
  const saved = await getVatReport(company.client, input.companyId, "2026-10");
  source = { ...source, rateBreakdown: [{ rate: 21, netAmount: "1100.00", vatAmount: "231.00" }, { rate: 12, netAmount: "900.00", vatAmount: "108.00" }],
    totals: { netAmount: "2000.00", vatAmount: "339.00", grossAmount: "2339.00" } };
  expect(await reprocessDocument(company.client, worker.jobs, { ...input, confirmed: true })).toEqual({ ok: true, value: null });
  worker.queued.push(...worker.queued);
  expect(await worker.runJobsConcurrently()).toEqual([]);
  const versions = await listExtractionVersions(company.client, input.companyId, input.documentId);
  expect(versions).toHaveLength(3);
  expect(versions.slice(0, 2)).toEqual(oldVersions);
  expect(versions[2].author).toEqual({ kind: "ai" });
  expect(versions[2].payload.partialClaim).toMatchObject({ ...claim, confirmed: false });
  expect(versions[2].payload.partialClaim?.basis).toEqual(oldVersions[1].payload.partialClaim?.basis);
  expect((await getDocument(company.client, input.companyId, input.documentId))?.status).toBe("needs_review");
  expect(await approveDocument(company.client, { ...input, version: 3 })).toEqual({ ok: false, error: "document_validation_failed" });
  expect((await getDocumentReview(company.client, input))?.shownFindings).toContainEqual({ field: "partialClaim", severity: "error", code: "partial_claim_invalid" });
  expect(await getVatReport(company.client, input.companyId, "2026-10")).toEqual(saved);
  const current = versions[2].payload;
  const renewed = { ...current, partialClaim: { ...current.partialClaim!, confirmed: true, basis: {
    documentType: current.documentType, direction: current.direction, currency: "EUR", proposedVatRegime: current.proposedVatRegime,
    taxPointDate: current.taxPointDate, rateBreakdown: source.rateBreakdown, totals: source.totals,
  } } };
  expect(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 3, requestId: crypto.randomUUID(), payload: renewed }, rates, registry))
    .toEqual({ ok: true, value: { version: 4 } });
  expect((await listExtractionVersions(company.client, input.companyId, input.documentId))[3].payload.partialClaim?.rateBreakdown).toEqual(claim.rateBreakdown);
});
