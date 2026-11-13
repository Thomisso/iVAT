import { expect, inject, it } from "vitest";
import { SAMPLE_EXTRACTION, fakeAiProvider } from "@/ai/fake";
import { approveDocument, correctDocument, createManualDocument, getDocument, listDocuments, listExtractionVersions, reprocessDocument, returnDocumentToReview, saveAndApproveDocument, updateDocumentReporting } from "@/application/documents";
import { administratorWithCompany, assignAiConfigurationFixture, companyMember } from "./support/fixtures";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { finalizeVatReport, generateVatReport, getVatReport, unlockReportingPeriod } from "@/application/vat-reports";
import { proportionalDeductionBasis } from "@/application/proportional-deduction";
import { exportFinalVatReport, exportVatReport, readVatReportArtifact } from "@/application/epo-export";
import { listAuditEvents } from "@/application/audit";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { testWorker } from "./support/worker";
import { uploadSourceFile } from "@/application/source-files";
import { fixtureFile } from "./support/files";
import { setOctoberImportFixture } from "./support/claim-eligibility";
import { withClaimDate } from "./support/claim-clock";
import { setCompanyAutomaticApproval } from "@/application/companies";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { getDocumentReview } from "@/application/document-review";

const source = { ...SAMPLE_EXTRACTION,
  rateBreakdown: [{ rate: 21, netAmount: "12000.00", vatAmount: "2520.00" }],
  totals: { netAmount: "12000.00", vatAmount: "2520.00", grossAmount: "14520.00" },
  claimEligibility: { period: "2026-10", origin: "user" as const, confirmed: true },
};
const ratio = { percentage: 50, confirmed: true, operatingExpenseConfirmed: true, actualUseConfirmed: true, origin: "user" as const };
const registry = fakeVatPayerRegistry();
const details = { taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", preparedOn: "2026-10-27", personType: "P",
  email: "qa@example.test", phone: "", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka" };

it.each<{ name: string; change: Partial<ExtractionPayload> }>([
  { name: "amounts", change: { rateBreakdown: [{ rate: 21, netAmount: "20000.00", vatAmount: "4200.00" }], totals: { netAmount: "20000.00", vatAmount: "4200.00", grossAmount: "24200.00" } } },
  { name: "rate", change: { rateBreakdown: [{ rate: 12, netAmount: "12000.00", vatAmount: "1440.00" }], totals: { netAmount: "12000.00", vatAmount: "1440.00", grossAmount: "13440.00" } } },
  { name: "currency", change: { currency: "EUR" } },
  { name: "direction", change: { direction: "outgoing" } },
  { name: "type", change: { documentType: "receipt" } },
  { name: "regime", change: { proposedVatRegime: "domestic_reverse_charge" } },
  { name: "tax point", change: { taxPointDate: "2026-11-27" } },
  { name: "original discrepancy", change: { totals: { ...source.totals, grossAmount: "14521.00" } } },
  { name: "earliest period", change: { claimEligibility: { period: "2026-11", origin: "user", confirmed: true } } },
])("a material $name correction cannot silently drop the prior human ratio", async ({ change }) => {
  const company = await administratorWithCompany();
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: { ...source, proportionalDeduction: ratio } }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await correctDocument(company.client, { ...input, basedOnVersion: 1, payload: { ...source, ...change } }, undefined, registry))
    .toEqual({ ok: true, value: { version: 2 } });
  expect((await listExtractionVersions(company.client, input.companyId, input.documentId))[1].payload.proportionalDeduction)
    .toMatchObject({ percentage: 50, confirmed: false, origin: "user" });
  expect((await company.client.rpc("approve_document", { target_document_id: input.documentId, reviewed_version: 2 })).error).not.toBeNull();
});

it("unrelated reference and payment changes preserve the existing confirmed ratio", async () => {
  const company = await administratorWithCompany();
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: { ...source, proportionalDeduction: ratio } }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await correctDocument(company.client, { ...input, basedOnVersion: 1, payload: {
    ...source, documentNumber: "REFERENCE-CORRECTED", dueDate: "2026-12-01", payment: { ...source.payment, variableSymbol: "987654" },
  } }, undefined, registry)).toEqual({ ok: true, value: { version: 2 } });
  expect((await listExtractionVersions(company.client, input.companyId, input.documentId))[1].payload.proportionalDeduction)
    .toMatchObject({ percentage: 50, confirmed: true, origin: "user" });
});

it("retains a ratio for harmless assignment but requires reconfirmation when its Earliest Claim Period changes", async () => {
  const company = await administratorWithCompany();
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: { ...source, proportionalDeduction: ratio } }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  const [original] = await listExtractionVersions(company.client, input.companyId, input.documentId);
  expect(await updateDocumentReporting(company.client, { ...input, claimedReportingPeriod: "2026-11" })).toEqual({ ok: true, value: null });
  expect(await listExtractionVersions(company.client, input.companyId, input.documentId)).toEqual([original]);
  // A direct authenticated command cannot bypass reconfirmation with empty findings.
  const corrected = await company.client.rpc("correct_document", { target_document_id: input.documentId, based_on_version: 1, payload: {
    ...original.payload, claimEligibility: { period: "2026-11", origin: "user", confirmed: true },
  }, findings: [] });
  expect(corrected.error).toBeNull();
  expect(corrected.data).toBe(2);
  const versions = await listExtractionVersions(company.client, input.companyId, input.documentId);
  expect(versions[0]).toEqual(original);
  expect(versions[1].payload.proportionalDeduction).toMatchObject({ percentage: 50, confirmed: false });
  expect(await approveDocument(company.client, { ...input, version: 2 })).toMatchObject({ ok: false, error: "document_validation_failed" });
  expect(await getDocument(company.client, input.companyId, input.documentId)).toMatchObject({ status: "needs_review" });
  const current = versions[1].payload;
  expect(await correctDocument(company.client, { ...input, basedOnVersion: 2, payload: {
    ...current, proportionalDeduction: { ...current.proportionalDeduction!, confirmed: true, basis: proportionalDeductionBasis(current) },
  } }, undefined, registry)).toEqual({ ok: true, value: { version: 3 } });
  expect(await approveDocument(company.client, { ...input, version: 3 })).toEqual({ ok: true, value: null });
  expect((await generateVatReport(company.client, { companyId: input.companyId, period: "2026-11" })).ok).toBe(true);
  expect((await getVatReport(company.client, input.companyId, "2026-11"))?.result.controlStatement)
    .toMatchObject([{ section: "B.2", proportionalDeduction: true, rateBreakdown: [{ netAmount: "6000.00", vatAmount: "1260.00" }] }]);
});

it.each([
  { name: "unchanged", net: "12000.00", vat: "2520.00", gross: "14520.00", claimedNet: "7200.00", claimedVat: "1512.00" },
  { name: "changed", net: "20000.00", vat: "4200.00", gross: "24200.00", claimedNet: "12000.00", claimedVat: "2520.00" },
])("an actual concurrent AI rerun with $name amounts cannot confirm or replace the human ratio or automatically approve it", async example => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    let rerun = false;
    const worker = testWorker(fakeAiProvider({ extract: () => rerun
      ? { ...source, rateBreakdown: [{ rate: 21, netAmount: example.net, vatAmount: example.vat }],
        totals: { netAmount: example.net, vatAmount: example.vat, grossAmount: example.gross },
        proportionalDeduction: { ...ratio, percentage: 99 } }
      : source }));
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    const uploaded = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await setOctoberImportFixture(uploaded.value.id);
    expect(await worker.runJobs()).toEqual([]);
    const [document] = await listDocuments(company.client, company.companyId, uploaded.value.id);
    const input = { companyId: company.companyId, documentId: document.id };
    expect(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 1, requestId: crypto.randomUUID(),
      payload: { ...source, proportionalDeduction: ratio } }, undefined, registry)).toEqual({ ok: true, value: { version: 2 } });
    expect((await generateVatReport(company.client, { companyId: input.companyId, period: "2026-10" })).ok).toBe(true);
    const saved = await getVatReport(company.client, input.companyId, "2026-10");
    const archived = await exportVatReport(company.client, { companyId: input.companyId, period: "2026-10", format: "dphkh1", details });
    if (!archived.ok) throw new Error(archived.error);
    const history = await listExtractionVersions(company.client, input.companyId, input.documentId);
    expect(await returnDocumentToReview(company.client, input)).toEqual({ ok: true, value: null });
    expect(await setCompanyAutomaticApproval(company.client, { companyId: input.companyId, enabled: true })).toEqual({ ok: true, value: null });
    rerun = true;
    expect(await reprocessDocument(company.client, worker.jobs, { ...input, confirmed: true })).toEqual({ ok: true, value: null });
    worker.queued.push({ ...worker.queued[0] });
    expect(await worker.runJobsConcurrently()).toEqual([]);
    const versions = await listExtractionVersions(company.client, input.companyId, input.documentId);
    expect(versions).toHaveLength(3);
    expect(versions.slice(0, 2)).toEqual(history);
    expect(versions[2]).toMatchObject({ author: { kind: "ai" }, payload: { proportionalDeduction: { percentage: 50, confirmed: false },
      totals: { netAmount: example.net, vatAmount: example.vat, grossAmount: example.gross } } });
    expect((await getDocumentReview(company.client, input))?.document.status).toBe("needs_review");
    expect((await getDocumentReview(company.client, input))?.shownFindings).toContainEqual(expect.objectContaining({ code: "proportional_deduction_invalid", severity: "error" }));
    expect(await getCompanyAiProcessingAllowance(company.client, input.companyId)).toMatchObject({ ok: true, value: { used: 2 } });
    expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "document.automatically_approved")).toEqual([]);
    expect(await approveDocument(company.client, { ...input, version: 3 })).toMatchObject({ ok: false, error: "document_validation_failed" });
    expect(await getVatReport(company.client, input.companyId, "2026-10")).toEqual(expect.objectContaining({ result: saved!.result }));
    const current = versions[2].payload;
    const confirmed = { ...current, claimEligibility: { ...current.claimEligibility!, confirmed: true },
      proportionalDeduction: { ...current.proportionalDeduction!, percentage: 60, confirmed: true, basis: proportionalDeductionBasis(current) } };
    expect(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 3, requestId: crypto.randomUUID(), payload: confirmed }, undefined, registry))
      .toEqual({ ok: true, value: { version: 4 } });
    expect((await generateVatReport(company.client, { companyId: input.companyId, period: "2026-10" })).ok).toBe(true);
    expect((await getVatReport(company.client, input.companyId, "2026-10"))?.result.controlStatement)
      .toMatchObject([{ section: "B.2", proportionalDeduction: true, rateBreakdown: [{ netAmount: example.claimedNet, vatAmount: example.claimedVat }] }]);
    expect((await readVatReportArtifact(company.client, { companyId: input.companyId, artifactId: archived.value.artifactId }))?.bytes).toEqual(archived.value.bytes);
    expect((await listExtractionVersions(company.client, input.companyId, input.documentId)).slice(0, 3)).toEqual(versions);
  });
});

it("material correction retains an omitted human decision, blocks reuse and preserves locked history and exact archived XML bytes", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const foreign = await administratorWithCompany();
  const created = await createManualDocument(user.client, { companyId: company.companyId, payload: source }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await saveAndApproveDocument(user.client, { ...input, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...source, proportionalDeduction: ratio } }, undefined, registry)).toEqual({ ok: true, value: { version: 2 } });
  expect((await generateVatReport(user.client, { companyId: input.companyId, period: "2026-10" })).ok).toBe(true);
  const saved = await getVatReport(user.client, input.companyId, "2026-10");
  const history = await listExtractionVersions(user.client, input.companyId, input.documentId);
  expect(await finalizeVatReport(company.client, { companyId: input.companyId, period: "2026-10", confirmed: true })).toEqual({ ok: true, value: null });
  const artifacts = [];
  for (const format of ["dphdp3", "dphkh1"]) {
    const exported = await exportFinalVatReport(user.client, { companyId: input.companyId, period: "2026-10", format, details });
    if (!exported.ok) throw new Error(exported.error);
    artifacts.push({ ...exported.value, format });
  }
  expect(await returnDocumentToReview(user.client, input)).toEqual({ ok: false, error: "period_locked" });
  const changed = { ...source, rateBreakdown: [{ rate: 21, netAmount: "20000.00", vatAmount: "4200.00" }],
    totals: { netAmount: "20000.00", vatAmount: "4200.00", grossAmount: "24200.00" } };
  expect((await user.client.rpc("correct_document", { target_document_id: input.documentId, based_on_version: 2, payload: changed, findings: [] })).error)
    .toMatchObject({ code: "P0001", hint: "not_in_review" });
  expect(await unlockReportingPeriod(company.client, { companyId: input.companyId, period: "2026-10", confirmed: true, reason: "Correct material source amounts" })).toEqual({ ok: true, value: null });
  expect(await returnDocumentToReview(user.client, input)).toEqual({ ok: true, value: null });
  expect(await correctDocument(user.client, { ...input, basedOnVersion: 2, payload: changed }, undefined, registry)).toEqual({ ok: true, value: { version: 3 } });
  let versions = await listExtractionVersions(user.client, input.companyId, input.documentId);
  expect(versions[2].payload).toMatchObject({ totals: changed.totals, proportionalDeduction: { percentage: 50, confirmed: false } });
  expect((await user.client.rpc("approve_document", { target_document_id: input.documentId, reviewed_version: 3 })).error)
    .toMatchObject({ code: "P0001", hint: "document_validation_failed" });
  expect(await saveAndApproveDocument(user.client, { ...input, basedOnVersion: 3, requestId: crypto.randomUUID(), payload: changed }, undefined, registry))
    .toMatchObject({ ok: false, error: "document_validation_failed" });
  expect(await getVatReport(user.client, input.companyId, "2026-10")).toEqual(expect.objectContaining({ result: saved!.result }));
  expect(await getDocument(foreign.client, input.companyId, input.documentId)).toBeNull();
  expect((await foreign.client.rpc("correct_document", { target_document_id: input.documentId, based_on_version: 3, payload: changed, findings: [] })).error)
    .toMatchObject({ code: "42501" });
  const candidate: ExtractionPayload = { ...changed, proportionalDeduction: { ...ratio, percentage: 60, basis: proportionalDeductionBasis(changed) } };
  const concurrent = await Promise.all([1, 2].map(() => correctDocument(user.client, { ...input, basedOnVersion: 3, payload: candidate }, undefined, registry)));
  expect(concurrent.filter(result => result.ok)).toEqual([{ ok: true, value: { version: 4 } }]);
  expect(concurrent.filter(result => !result.ok)).toEqual([{ ok: false, error: "stale_version" }]);
  expect(await approveDocument(user.client, { ...input, version: 3 })).toEqual({ ok: false, error: "stale_version" });
  expect(await approveDocument(user.client, { ...input, version: 4 })).toEqual({ ok: true, value: null });
  versions = await listExtractionVersions(user.client, input.companyId, input.documentId);
  expect(versions.slice(0, 2)).toEqual(history);
  expect(versions[3].author).toEqual({ kind: "user", userId: user.userId });
  const audits = (await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "document.proportional_deduction_changed");
  expect(audits).toContainEqual(expect.objectContaining({ actorUserId: user.userId,
    payload: { version: 4, extractionVersionId: versions[3].id, percentage: 60, confirmed: true } }));
  expect((await generateVatReport(user.client, { companyId: input.companyId, period: "2026-10" })).ok).toBe(true);
  expect((await getVatReport(user.client, input.companyId, "2026-10"))?.result.controlStatement)
    .toMatchObject([{ section: "B.2", proportionalDeduction: true, rateBreakdown: [{ netAmount: "12000.00", vatAmount: "2520.00" }] }]);
  for (const artifact of artifacts) {
    expect((await readVatReportArtifact(user.client, { companyId: input.companyId, artifactId: artifact.artifactId }))?.bytes).toEqual(artifact.bytes);
    expect(await readVatReportArtifact(foreign.client, { companyId: input.companyId, artifactId: artifact.artifactId })).toBeNull();
    expect(new TextDecoder().decode(artifact.bytes)).toMatch(artifact.format === "dphkh1" ? /pomer="A"[^>]*zakl_dane1="6000.00" dan1="1260.00"/ : /pln23="6000" odp_tuz23_nar="1260"/);
  }
});
