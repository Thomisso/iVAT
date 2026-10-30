import { expect, inject, it } from "vitest";
import { Client as DatabaseClient } from "pg";
import { acknowledgeVatReportDownload, exportFinalVatReport, exportVatReport, getVatReportDraftProgress, listVatReportArtifacts, readVatReportArtifact, skipVatReportDrafts } from "@/application/epo-export";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { finalizeVatReport, generateVatReport, getVatReport } from "@/application/vat-reports";
import { getVatProcessingWizard } from "@/application/vat-processing";
import { listAuditEvents } from "@/application/audit";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { provisionedUser } from "./support/clients";
import { exportCompanyData } from "@/application/company-deletion";
import { testWorker } from "./support/worker";
import { strFromU8, unzipSync } from "fflate";

async function prepared() {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-01" };
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId, taxOffice: "451", economicActivity: "621000",
    signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "director",
    email: "", phone: "", epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });
  await generateVatReport(company.client, input);
  const report = await getVatReport(company.client, company.companyId, input.period);
  if (!report) throw new Error("Report missing");
  return { ...company, input, reportGeneratedAt: report.generatedAt, reportId: report.id };
}
async function exported(company: Awaited<ReturnType<typeof prepared>>, format = "dphdp3") {
  const result = await exportVatReport(company.client, { ...company.input, format, details: {} });
  if (!result.ok) throw new Error(result.error);
  return { ...company.input, artifactId: result.value.artifactId, reportGeneratedAt: result.value.reportGeneratedAt, format };
}
async function progress(company: Awaited<ReturnType<typeof prepared>>) {
  const report = await getVatReport(company.client, company.companyId, company.input.period);
  if (!report) throw new Error("Report missing");
  return getVatReportDraftProgress(company.client, { ...company.input, reportGeneratedAt: report.generatedAt });
}

it("counts two distinct acknowledged outputs shared across Company users, with idempotent concurrent callbacks", async () => {
  const company = await prepared();
  const colleague = await companyMember(company);
  const first = await exported(company);
  expect(await progress(company)).toEqual({ downloadedFormats: [], skippedFormats: [] });
  expect(await Promise.all([
    acknowledgeVatReportDownload(company.client, first), acknowledgeVatReportDownload(colleague.client, first),
  ])).toEqual([{ ok: true, value: null }, { ok: true, value: null }]);
  expect(await getVatReportDraftProgress(colleague.client, { ...company.input, reportGeneratedAt: company.reportGeneratedAt }))
    .toEqual({ downloadedFormats: ["dphdp3"], skippedFormats: [] });
  expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "vat_report_artifact.download_acknowledged")).toHaveLength(1);
  expect(await acknowledgeVatReportDownload(colleague.client, await exported(company))).toEqual({ ok: true, value: null });
  expect(await progress(company)).toEqual({ downloadedFormats: ["dphdp3"], skippedFormats: [] });
  const wizard = await getVatProcessingWizard(colleague.client, company.input);
  expect(wizard.ok && wizard.value.steps[3].state).toBe("partial");
  expect(await acknowledgeVatReportDownload(colleague.client, await exported(company, "dphkh1"))).toEqual({ ok: true, value: null });
  expect(await progress(company)).toEqual({ downloadedFormats: ["dphdp3", "dphkh1"], skippedFormats: [] });
  const audit = (await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "vat_report_artifact.download_acknowledged").at(-1);
  expect(audit?.actorUserId).toBe(colleague.userId);
  expect(JSON.stringify(audit?.payload)).not.toContain(colleague.email);
  const complete = await getVatProcessingWizard(company.client, company.input);
  expect(complete.ok && complete.value.steps[3].state).toBe("done");
});

it("retains skip-both and skip-remainder history while permitting later draft downloads", async () => {
  const company = await prepared();
  const skip = { ...company.input, reportGeneratedAt: company.reportGeneratedAt };
  expect(await skipVatReportDrafts(company.client, skip)).toEqual({ ok: true, value: null });
  expect(await skipVatReportDrafts(company.client, skip)).toEqual({ ok: true, value: null });
  expect(await progress(company)).toEqual({ downloadedFormats: [], skippedFormats: ["dphdp3", "dphkh1"] });
  const skipped = await getVatProcessingWizard(company.client, company.input);
  expect(skipped.ok && skipped.value.steps[3].state).toBe("skipped");
  expect(await acknowledgeVatReportDownload(company.client, await exported(company))).toEqual({ ok: true, value: null });
  expect(await progress(company)).toEqual({ downloadedFormats: ["dphdp3"], skippedFormats: ["dphkh1"] });
  expect(await acknowledgeVatReportDownload(company.client, await exported(company, "dphkh1"))).toEqual({ ok: true, value: null });
  expect(await progress(company)).toEqual({ downloadedFormats: ["dphdp3", "dphkh1"], skippedFormats: [] });
});

it.each([0, 1])("does not make %i draft downloads or a skip choice a prerequisite for Finalization", async count => {
  const company = await prepared();
  if (count) await acknowledgeVatReportDownload(company.client, await exported(company));
  await skipVatReportDrafts(company.client, { ...company.input, reportGeneratedAt: company.reportGeneratedAt });
  expect(await finalizeVatReport(company.client, { ...company.input, confirmed: true })).toEqual({ ok: true, value: null });
});

it("resets only current-generation progress after regeneration and refuses stale acknowledgements and skips", async () => {
  const company = await prepared();
  const old = await exported(company);
  await acknowledgeVatReportDownload(company.client, old);
  await skipVatReportDrafts(company.client, { ...company.input, reportGeneratedAt: company.reportGeneratedAt });
  await generateVatReport(company.client, company.input);
  const current = await getVatReport(company.client, company.companyId, company.input.period);
  expect(current?.id).toBe(company.reportId);
  expect(current?.generatedAt).not.toBe(company.reportGeneratedAt);
  expect(await progress(company)).toEqual({ downloadedFormats: [], skippedFormats: [] });
  expect(await acknowledgeVatReportDownload(company.client, old)).toEqual({ ok: false, error: "invalid_download_artifact" });
  expect(await acknowledgeVatReportDownload(company.client, { ...old, reportGeneratedAt: current!.generatedAt })).toEqual({ ok: false, error: "invalid_download_artifact" });
  expect(await skipVatReportDrafts(company.client, { ...company.input, reportGeneratedAt: company.reportGeneratedAt })).toEqual({ ok: false, error: "stale_report" });
  expect(await listVatReportArtifacts(company.client, company.input)).toHaveLength(1);
  expect((await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: old.artifactId }))?.bytes.byteLength).toBeGreaterThan(0);
});

it("refuses mismatched Company, period, format, generation and artifact identities", async () => {
  const company = await prepared();
  const other = await prepared();
  const artifact = await exported(company);
  await generateVatReport(company.client, { ...company.input, period: "2026-02" });
  expect(await acknowledgeVatReportDownload(other.client, {
    ...artifact, companyId: other.companyId, reportGeneratedAt: other.reportGeneratedAt,
  })).toEqual({ ok: false, error: "invalid_download_artifact" });
  for (const input of [
    { ...artifact, period: "2026-02" },
    { ...artifact, format: "dphkh1" },
    { ...artifact, reportGeneratedAt: "2000-01-01T00:00:00Z" },
    { ...artifact, artifactId: crypto.randomUUID() },
  ]) expect(await acknowledgeVatReportDownload(company.client, input)).toEqual({ ok: false, error: "invalid_download_artifact" });
  expect(await progress(company)).toEqual({ downloadedFormats: [], skippedFormats: [] });
});

it("isolates both append-only progress tables and their privileged commands across Organizations", async () => {
  const company = await prepared();
  const outsider = await provisionedUser();
  const artifact = await exported(company);
  await acknowledgeVatReportDownload(company.client, artifact);
  await skipVatReportDrafts(company.client, { ...company.input, reportGeneratedAt: company.reportGeneratedAt });
  expect(await acknowledgeVatReportDownload(outsider.client, artifact)).toEqual({ ok: false, error: "forbidden" });
  expect(await skipVatReportDrafts(outsider.client, { ...company.input, reportGeneratedAt: company.reportGeneratedAt })).toEqual({ ok: false, error: "forbidden" });
  expect((await outsider.client.from("vat_report_download_acknowledgement").insert({
    artifact_id: artifact.artifactId, company_id: company.companyId, organization_id: company.organizationId,
    acknowledged_by: outsider.userId,
  })).error?.code).toBe("42501");
  expect((await outsider.client.from("vat_report_draft_skip").insert({
    vat_report_id: company.reportId, company_id: company.companyId, organization_id: company.organizationId,
    report_generated_at: company.reportGeneratedAt, skipped_formats: ["dphdp3"], skipped_by: outsider.userId,
  })).error?.code).toBe("42501");
  for (const table of ["vat_report_download_acknowledgement", "vat_report_draft_skip"] as const) {
    expect((await outsider.client.from(table).select("company_id").eq("company_id", company.companyId)).data).toEqual([]);
    expect((await outsider.client.from(table).delete().eq("company_id", company.companyId)).error?.code).toBe("42501");
    expect((await company.client.from(table).delete().eq("company_id", company.companyId)).error?.code).toBe("42501");
  }
});

it("aggregates distinct output acknowledgements beyond the PostgREST row limit", async () => {
  const company = await prepared();
  const first = await exported(company);
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    // Fixture-only copies of one application-validated XML isolate aggregate completeness.
    await database.query(`with copies as (
      insert into public.vat_report_artifact (
        organization_id, company_id, vat_report_id, report_generated_at, period, format, kind,
        file_name, media_type, xml_bytes, resolved_details, schema_version, serializer_version, created_by
      ) select original.organization_id, original.company_id, original.vat_report_id, original.report_generated_at,
        original.period, original.format, original.kind, original.file_name, original.media_type, original.xml_bytes,
        original.resolved_details, original.schema_version, original.serializer_version, original.created_by
      from public.vat_report_artifact original cross join generate_series(1, 1001) n where original.id = $1 returning *
    ) insert into public.vat_report_download_acknowledgement (artifact_id, company_id, organization_id, acknowledged_by)
      select id, company_id, organization_id, created_by from copies`, [first.artifactId]);
  } finally { await database.end(); }
  await acknowledgeVatReportDownload(company.client, await exported(company, "dphkh1"));
  expect(await progress(company)).toEqual({ downloadedFormats: ["dphdp3", "dphkh1"], skippedFormats: [] });
});

it("returns a refusal for malformed generation input before PostgreSQL timestamp parsing", async () => {
  const company = await prepared();
  const artifact = await exported(company);
  expect(await acknowledgeVatReportDownload(company.client, { ...artifact, reportGeneratedAt: "0" })).toEqual({ ok: false, error: "invalid_download_artifact" });
  expect(await skipVatReportDrafts(company.client, { ...company.input, reportGeneratedAt: "2026-02-31T00:00:00Z" })).toEqual({ ok: false, error: "stale_report" });
});

it.each(["acknowledge", "skip"] as const)("returns the %s refusal for ISO year zero instead of a database error", async command => {
  const company = await prepared();
  const artifact = await exported(company);
  const input = { ...artifact, reportGeneratedAt: "0000-01-01T00:00:00Z" };
  const result = command === "acknowledge"
    ? await acknowledgeVatReportDownload(company.client, input)
    : await skipVatReportDrafts(company.client, input);
  expect(result).toEqual({ ok: false, error: command === "acknowledge" ? "invalid_download_artifact" : "stale_report" });
  expect(await progress(company)).toEqual({ downloadedFormats: [], skippedFormats: [] });
});

it("retains old-generation acknowledgements and skip history in the complete Company archive", async () => {
  const company = await prepared();
  const artifact = await exported(company);
  await acknowledgeVatReportDownload(company.client, artifact);
  await skipVatReportDrafts(company.client, { ...company.input, reportGeneratedAt: company.reportGeneratedAt });
  await generateVatReport(company.client, company.input);
  const worker = testWorker();
  const result = await exportCompanyData(company.client, worker.jobs, { companyId: company.companyId });
  if (!result.ok) throw new Error(result.error);
  expect(await worker.runJobs()).toEqual([]);
  const archive = unzipSync(result.value.bytes);
  expect(archive["vat-report-download-acknowledgements.json"]).toBeDefined();
  expect(JSON.parse(strFromU8(archive["vat-report-download-acknowledgements.json"]))).toEqual([
    expect.objectContaining({ artifactId: artifact.artifactId }),
  ]);
  expect(JSON.parse(strFromU8(archive["vat-report-draft-skips.json"]))).toEqual([
    expect.objectContaining({ reportGeneratedAt: company.reportGeneratedAt, skippedFormats: ["dphkh1"] }),
  ]);
});

it("refuses new draft acknowledgements and skips after locking, and never counts final XML as a draft", async () => {
  const company = await prepared();
  const draft = await exported(company);
  await finalizeVatReport(company.client, { ...company.input, confirmed: true });
  const final = await exportFinalVatReport(company.client, { ...company.input, format: "dphdp3", details: {} });
  if (!final.ok) throw new Error(final.error);
  expect(await acknowledgeVatReportDownload(company.client, {
    ...draft, artifactId: final.value.artifactId,
  })).toEqual({ ok: false, error: "invalid_download_artifact" });
  expect(await acknowledgeVatReportDownload(company.client, draft)).toEqual({ ok: false, error: "report_finalized" });
  expect(await skipVatReportDrafts(company.client, { ...company.input, reportGeneratedAt: company.reportGeneratedAt })).toEqual({ ok: false, error: "report_finalized" });
  expect(await progress(company)).toEqual({ downloadedFormats: [], skippedFormats: [] });
});
