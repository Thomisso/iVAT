import { strFromU8, unzipSync } from "fflate";
import { Client as DatabaseClient } from "pg";
import { expect, inject, it } from "vitest";
import { signedUpUser } from "./support/clients";
import { listAuditEvents } from "@/application/audit";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { finalizeVatReport, generateVatReport, getPeriodLock, getVatReport, listVatReportTransitions, unlockReportingPeriod } from "@/application/vat-reports";
import { acknowledgeVatReportDownload, exportFinalVatReport, exportVatReport, listVatReportArtifacts, readVatReportArtifact } from "@/application/epo-export";
import { exportCompanyData, softDeleteCompany } from "@/application/company-deletion";
import { testWorker } from "./support/worker";
import { getVatProcessingWizard } from "@/application/vat-processing";
import { administratorWithCompany, companyMember } from "./support/fixtures";

async function prepared() {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-01" };
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId, taxOffice: "451", economicActivity: "621000",
    signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "director",
    email: "", phone: "", epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });
  expect((await generateVatReport(company.client, input)).ok).toBe(true);
  return { ...company, input };
}

it("creates a distinct lock identity for every real Finalization even without regenerating the report", async () => {
  const company = await prepared();
  const before = await getVatReport(company.client, company.companyId, company.input.period);
  expect(await finalizeVatReport(company.client, { ...company.input, confirmed: true })).toEqual({ ok: true, value: null });
  const first = await getPeriodLock(company.client, company.companyId, company.input.period);
  expect(first?.id).toMatch(/^[0-9a-f-]{36}$/);
  await finalizeVatReport(company.client, { ...company.input, confirmed: true });
  expect(await getPeriodLock(company.client, company.companyId, company.input.period)).toEqual(first);
  expect(await unlockReportingPeriod(company.client, { ...company.input, confirmed: true, reason: "Review again" })).toEqual({ ok: true, value: null });
  await finalizeVatReport(company.client, { ...company.input, confirmed: true });
  const second = await getPeriodLock(company.client, company.companyId, company.input.period);
  expect(second?.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(second?.id).not.toBe(first?.id);
  expect((await getVatReport(company.client, company.companyId, company.input.period))?.generatedAt).toBe(before?.generatedAt);
});

it("completes final progress only for two distinct acknowledged final outputs shared by Company users", async () => {
  const company = await prepared();
  const colleague = await companyMember(company);
  const draft = await exportVatReport(company.client, { ...company.input, format: "dphdp3", details: {} });
  if (!draft.ok) throw new Error(draft.error);
  await acknowledgeVatReportDownload(company.client, {
    ...company.input, format: "dphdp3", artifactId: draft.value.artifactId, reportGeneratedAt: draft.value.reportGeneratedAt,
  });
  await finalizeVatReport(company.client, { ...company.input, confirmed: true });
  async function current() {
    const result = await getVatProcessingWizard(colleague.client, company.input);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  expect((await current()).steps[4].state).toBe("partial");
  expect((await current()).finalExport.downloadedFormats).toEqual([]);
  async function final(format: string) {
    const result = await exportFinalVatReport(colleague.client, { ...company.input, format, details: {} });
    if (!result.ok) throw new Error(result.error);
    return { ...company.input, format, artifactId: result.value.artifactId,
      reportGeneratedAt: result.value.reportGeneratedAt, periodLockId: result.value.periodLockId };
  }
  const first = await final("dphdp3");
  expect((await current()).finalExport.downloadedFormats).toEqual([]);
  expect(await Promise.all([
    acknowledgeVatReportDownload(company.client, first), acknowledgeVatReportDownload(colleague.client, first),
  ])).toEqual([{ ok: true, value: null }, { ok: true, value: null }]);
  expect((await current()).steps[4].state).toBe("partial");
  expect((await current()).finalExport.downloadedFormats).toEqual(["dphdp3"]);
  expect(await acknowledgeVatReportDownload(colleague.client, await final("dphdp3"))).toEqual({ ok: true, value: null });
  expect((await current()).finalExport.downloadedFormats).toEqual(["dphdp3"]);
  expect(await acknowledgeVatReportDownload(company.client, await final("dphkh1"))).toEqual({ ok: true, value: null });
  expect((await current()).finalExport.downloadedFormats).toEqual(["dphdp3", "dphkh1"]);
  expect((await current()).steps[4].state).toBe("done");
});

it("keeps old lock history while refusing its artifacts for a new lock on the unchanged generation", async () => {
  const company = await prepared();
  await finalizeVatReport(company.client, { ...company.input, confirmed: true });
  const firstLock = await getPeriodLock(company.client, company.companyId, company.input.period);
  const first = await exportFinalVatReport(company.client, { ...company.input, format: "dphdp3", details: {} });
  if (!first.ok) throw new Error(first.error);
  expect(first.value.periodLockId).toBe(firstLock!.id);
  const acknowledgement = { ...company.input, format: "dphdp3", artifactId: first.value.artifactId,
    reportGeneratedAt: first.value.reportGeneratedAt, periodLockId: first.value.periodLockId };
  expect(await acknowledgeVatReportDownload(company.client, acknowledgement)).toEqual({ ok: true, value: null });
  await unlockReportingPeriod(company.client, { ...company.input, confirmed: true, reason: "Check again" });
  expect(await acknowledgeVatReportDownload(company.client, acknowledgement)).toEqual({ ok: false, error: "invalid_download_artifact" });
  await finalizeVatReport(company.client, { ...company.input, confirmed: true });
  const secondLock = await getPeriodLock(company.client, company.companyId, company.input.period);
  for (const periodLockId of [firstLock!.id, secondLock!.id, crypto.randomUUID(), null]) {
    expect(await acknowledgeVatReportDownload(company.client, { ...acknowledgement, periodLockId }))
      .toEqual({ ok: false, error: "invalid_download_artifact" });
  }
  const current = await getVatProcessingWizard(company.client, company.input);
  expect(current.ok && current.value.finalExport.downloadedFormats).toEqual([]);
  expect(current.ok && current.value.steps[4].state).toBe("partial");
  expect((await listVatReportArtifacts(company.client, company.input))[0].periodLockId).toBe(firstLock!.id);
  expect((await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: first.value.artifactId }))?.bytes).toEqual(first.value.bytes);
  expect((await listVatReportTransitions(company.client, company.companyId, company.input.period)).map(t => t.periodLockId))
    .toEqual([firstLock!.id, firstLock!.id, secondLock!.id]);
});

it("archives cycle identities and acknowledgements, invalidating deletion receipts after a final download", async () => {
  const company = await prepared();
  const worker = testWorker();
  await finalizeVatReport(company.client, { ...company.input, confirmed: true });
  const lock = await getPeriodLock(company.client, company.companyId, company.input.period);
  const final = await exportFinalVatReport(company.client, { ...company.input, format: "dphdp3", details: {} });
  if (!final.ok) throw new Error(final.error);
  const priorArchive = await exportCompanyData(company.client, worker.jobs, { companyId: company.companyId });
  if (!priorArchive.ok) throw new Error(priorArchive.error);
  expect(await worker.runJobs()).toEqual([]);
  await acknowledgeVatReportDownload(company.client, { ...company.input, format: "dphdp3", artifactId: final.value.artifactId,
    reportGeneratedAt: final.value.reportGeneratedAt, periodLockId: final.value.periodLockId });
  expect(await softDeleteCompany(company.client, { companyId: company.companyId, exportId: priorArchive.value.exportId }))
    .toEqual({ ok: false, error: "stale_export" });
  await unlockReportingPeriod(company.client, { ...company.input, confirmed: true, reason: "Recheck archived report" });
  await finalizeVatReport(company.client, { ...company.input, confirmed: true });
  const archive = await exportCompanyData(company.client, worker.jobs, { companyId: company.companyId });
  if (!archive.ok) throw new Error(archive.error);
  expect(await worker.runJobs()).toEqual([]);
  const files = unzipSync(archive.value.bytes);
  const metadata = (name: string) => JSON.parse(strFromU8(files[name]));
  expect(metadata("vat-report-artifacts.json")).toEqual([expect.objectContaining({ id: final.value.artifactId, periodLockId: lock!.id })]);
  expect(metadata("vat-report-download-acknowledgements.json")).toEqual([expect.objectContaining({ artifactId: final.value.artifactId, periodLockId: lock!.id })]);
  expect(metadata("vat-report-transitions.json").map((t: { periodLockId: string }) => t.periodLockId))
    .toEqual([lock!.id, lock!.id, (await getPeriodLock(company.client, company.companyId, company.input.period))!.id]);
  expect(files[`vat-report-artifacts/${final.value.artifactId}/${final.value.fileName}`]).toEqual(final.value.bytes);
});

it("refuses mismatched final identities and preserves actual-user audit attribution", async () => {
  const company = await prepared();
  const colleague = await companyMember(company);
  const outsider = await signedUpUser();
  await finalizeVatReport(company.client, { ...company.input, confirmed: true });
  const result = await exportFinalVatReport(company.client, { ...company.input, format: "dphdp3", details: {} });
  if (!result.ok) throw new Error(result.error);
  const input = { ...company.input, format: "dphdp3", artifactId: result.value.artifactId,
    reportGeneratedAt: result.value.reportGeneratedAt, periodLockId: result.value.periodLockId };
  expect(await acknowledgeVatReportDownload(outsider.client, input)).toEqual({ ok: false, error: "forbidden" });
  for (const invalid of [
    { ...input, periodLockId: crypto.randomUUID() }, { ...input, periodLockId: "invalid" },
    { ...input, format: "dphkh1" }, { ...input, period: "2026-02" },
    { ...input, reportGeneratedAt: "2025-01-01T00:00:00Z" },
  ]) expect(await acknowledgeVatReportDownload(company.client, invalid)).toEqual({ ok: false, error: "invalid_download_artifact" });
  expect(await acknowledgeVatReportDownload(colleague.client, input)).toEqual({ ok: true, value: null });
  expect(await acknowledgeVatReportDownload(company.client, input)).toEqual({ ok: true, value: null });
  const audit = (await listAuditEvents(company.client, company.organizationId)).filter(e => e.action === "vat_report_artifact.download_acknowledged");
  expect(audit).toHaveLength(1);
  expect(audit[0].actorUserId).toBe(colleague.userId);
  expect(audit[0].payload).toMatchObject({ period_lock_id: result.value.periodLockId, kind: "final", format: "dphdp3" });
  expect(JSON.stringify(audit[0].payload)).not.toContain(colleague.email);
});

it("keeps legacy final bytes downloadable without guessing their lock-cycle applicability", async () => {
  const company = await prepared();
  await finalizeVatReport(company.client, { ...company.input, confirmed: true });
  const lock = await getPeriodLock(company.client, company.companyId, company.input.period);
  const final = await exportFinalVatReport(company.client, { ...company.input, format: "dphdp3", details: {} });
  if (!final.ok) throw new Error(final.error);
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  let legacyId: string;
  try {
    // A retained pre-migration artifact has no lock identity; its bytes were already validated.
    const legacy = await database.query<{ id: string }>(`insert into public.vat_report_artifact (
      organization_id, company_id, vat_report_id, report_generated_at, period, format, kind,
      file_name, media_type, xml_bytes, resolved_details, schema_version, serializer_version, created_by
    ) select organization_id, company_id, vat_report_id, report_generated_at, period, format, kind,
      file_name, media_type, xml_bytes, resolved_details, schema_version, serializer_version, created_by
      from public.vat_report_artifact where id = $1 returning id`, [final.value.artifactId]);
    legacyId = legacy.rows[0].id;
  } finally { await database.end(); }
  const legacy = await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: legacyId });
  expect(legacy?.artifact.periodLockId).toBe(null);
  expect(legacy?.bytes).toEqual(final.value.bytes);
  for (const periodLockId of [null, lock!.id]) expect(await acknowledgeVatReportDownload(company.client, {
    ...company.input, format: "dphdp3", artifactId: legacyId, reportGeneratedAt: final.value.reportGeneratedAt, periodLockId,
  })).toEqual({ ok: false, error: "invalid_download_artifact" });
  const wizard = await getVatProcessingWizard(company.client, company.input);
  expect(wizard.ok && wizard.value.finalExport.downloadedFormats).toEqual([]);
});

it("counts distinct final formats beyond the PostgREST row limit for the current cycle", async () => {
  const company = await prepared();
  await finalizeVatReport(company.client, { ...company.input, confirmed: true });
  const first = await exportFinalVatReport(company.client, { ...company.input, format: "dphdp3", details: {} });
  if (!first.ok) throw new Error(first.error);
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    // Fixture-only copies of one application-validated final XML isolate aggregate completeness.
    await database.query(`with copies as (
      insert into public.vat_report_artifact (
        organization_id, company_id, vat_report_id, report_generated_at, period, format, kind,
        file_name, media_type, xml_bytes, resolved_details, schema_version, serializer_version, created_by, period_lock_id
      ) select original.organization_id, original.company_id, original.vat_report_id, original.report_generated_at,
        original.period, original.format, original.kind, original.file_name, original.media_type, original.xml_bytes,
        original.resolved_details, original.schema_version, original.serializer_version, original.created_by, original.period_lock_id
      from public.vat_report_artifact original cross join generate_series(1, 1001) n where original.id = $1 returning *
    ) insert into public.vat_report_download_acknowledgement (artifact_id, company_id, organization_id, acknowledged_by, period_lock_id)
      select id, company_id, organization_id, created_by, period_lock_id from copies`, [first.value.artifactId]);
  } finally { await database.end(); }
  const second = await exportFinalVatReport(company.client, { ...company.input, format: "dphkh1", details: {} });
  if (!second.ok) throw new Error(second.error);
  expect(await acknowledgeVatReportDownload(company.client, { ...company.input, format: "dphkh1", artifactId: second.value.artifactId,
    reportGeneratedAt: second.value.reportGeneratedAt, periodLockId: second.value.periodLockId })).toEqual({ ok: true, value: null });
  const wizard = await getVatProcessingWizard(company.client, company.input);
  expect(wizard.ok && wizard.value.finalExport.downloadedFormats).toEqual(["dphdp3", "dphkh1"]);
});
