import { expect, it } from "vitest";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { acknowledgeVatReportDownload, exportVatReport } from "@/application/epo-export";
import { getVatProcessingWizard } from "@/application/vat-processing";
import { finalizeVatReport, generateVatReport } from "@/application/vat-reports";
import { approveDocument, listDocuments } from "@/application/documents";
import { uploadSourceFile } from "@/application/source-files";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
  companyMember,
} from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";

function stepStates(
  wizard: Awaited<ReturnType<typeof getVatProcessingWizard>>,
) {
  if (!wizard.ok) throw new Error(wizard.error);
  return wizard.value.steps.map(({ key, state, reason, blockedBy }) => ({
    key,
    state,
    reason,
    blockedBy,
  }));
}

it("does not complete a draft output merely because XML was archived", async () => {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-01" };
  await generateVatReport(company.client, input);
  const artifact = await exportVatReport(company.client, {
    ...input, format: "dphdp3", details: {
      taxOffice: "451", economicActivity: "621000", preparedOn: "2026-02-10",
      signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "director",
    },
  });
  expect(artifact.ok).toBe(true);
  expect(stepStates(await getVatProcessingWizard(company.client, input))[3]).toEqual({
    key: "export", state: "not_started", reason: null, blockedBy: null,
  });
});

it("walks an empty Reporting Period from generation through export to Finalization", async () => {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-01" };

  expect(stepStates(await getVatProcessingWizard(company.client, input))).toEqual([
    { key: "review", state: "done", reason: null, blockedBy: null },
    { key: "generate", state: "not_started", reason: "report_missing", blockedBy: null },
    { key: "outputs", state: "blocked", reason: "report_missing", blockedBy: "generate" },
    { key: "export", state: "blocked", reason: "report_missing", blockedBy: "generate" },
    { key: "finalize", state: "blocked", reason: "report_missing", blockedBy: "generate" },
  ]);

  expect((await generateVatReport(company.client, input)).ok).toBe(true);
  expect(stepStates(await getVatProcessingWizard(company.client, input))).toEqual([
    { key: "review", state: "done", reason: null, blockedBy: null },
    { key: "generate", state: "done", reason: null, blockedBy: null },
    { key: "outputs", state: "done", reason: null, blockedBy: null },
    { key: "export", state: "not_started", reason: null, blockedBy: null },
    { key: "finalize", state: "not_started", reason: null, blockedBy: null },
  ]);

  const user = await companyMember(company);
  expect(stepStates(await getVatProcessingWizard(user.client, input)).at(-1)).toEqual({
    key: "finalize",
    state: "blocked",
    reason: "administrator_only",
    blockedBy: null,
  });

  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId,
    taxOffice: "451",
    territorialOffice: "2003",
    economicActivity: "621000",
    signatoryFirstName: "Jana",
    signatoryLastName: "Nováková",
    signatoryCapacity: "jednatelka",
    email: "podatelna@example.test",
    phone: "+420123456789",
    epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });
  async function acknowledgeBothOutputs() {
    for (const format of ["dphdp3", "dphkh1"]) {
      const exported = await exportVatReport(company.client, { ...input, format, details: { preparedOn: "2026-02-10" } });
      if (!exported.ok) throw new Error(exported.error);
      expect(await acknowledgeVatReportDownload(company.client, {
        ...input, format, artifactId: exported.value.artifactId, reportGeneratedAt: exported.value.reportGeneratedAt,
      })).toEqual({ ok: true, value: null });
    }
  }
  await acknowledgeBothOutputs();
  expect(stepStates(await getVatProcessingWizard(company.client, input))[3]).toEqual({
    key: "export",
    state: "done",
    reason: null,
    blockedBy: null,
  });

  // Regeneration replaces the snapshot while keeping its report id. Its old
  // export must not complete the new snapshot's export step.
  expect((await generateVatReport(company.client, input)).ok).toBe(true);
  expect(stepStates(await getVatProcessingWizard(company.client, input))[3]).toEqual({
    key: "export", state: "not_started", reason: null, blockedBy: null,
  });
  await acknowledgeBothOutputs();

  expect(await finalizeVatReport(company.client, { ...input, confirmed: true }))
    .toEqual({ ok: true, value: null });
  const finalized = await getVatProcessingWizard(company.client, input);
  expect(stepStates(finalized).map(({ state }) => state)).toEqual([
    "done",
    "done",
    "done",
    "done",
    "done",
  ]);
  expect(finalized.ok && finalized.value.locked).toBe(true);
});

it("lists the Documents still needing review and blocks later steps until they are resolved", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker();
  await enableAiProcessing(company.client, worker.jobs, {
    companyId: company.companyId,
    provider: worker.ai,
  });
  const uploaded = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "review.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const input = { companyId: company.companyId, period: "2026-10" };
  expect((await generateVatReport(company.client, input)).ok).toBe(true);

  const pending = await getVatProcessingWizard(company.client, input);
  expect(stepStates(pending)).toEqual([
    { key: "review", state: "needs_attention", reason: "documents_need_review", blockedBy: null },
    { key: "generate", state: "blocked", reason: "documents_need_review", blockedBy: "review" },
    { key: "outputs", state: "blocked", reason: "documents_need_review", blockedBy: "review" },
    { key: "export", state: "blocked", reason: "documents_need_review", blockedBy: "review" },
    { key: "finalize", state: "blocked", reason: "documents_need_review", blockedBy: "review" },
  ]);
  if (!pending.ok) throw new Error(pending.error);
  const documents = await listDocuments(company.client, company.companyId, uploaded.value.id);
  expect(pending.value.documentsToReviewCount).toBe(2);
  expect(pending.value.documentsToReview.map((document) => document.id).toSorted())
    .toEqual(documents.map((document) => document.id).toSorted());

  for (const document of documents) {
    expect(await approveDocument(company.client, {
      companyId: company.companyId,
      documentId: document.id,
      version: 1,
    })).toEqual({ ok: true, value: null });
  }
  const approved = await getVatProcessingWizard(company.client, input);
  expect(stepStates(approved).slice(0, 3)).toEqual([
    { key: "review", state: "done", reason: null, blockedBy: null },
    { key: "generate", state: "needs_attention", reason: "report_stale", blockedBy: null },
    { key: "outputs", state: "blocked", reason: "report_stale", blockedBy: "generate" },
  ]);
  expect(approved.ok && approved.value.documentsToReview).toEqual([]);

  expect((await generateVatReport(company.client, input)).ok).toBe(true);
  expect(stepStates(await getVatProcessingWizard(company.client, input)).map(({ state }) => state))
    .toEqual(["done", "done", "done", "not_started", "not_started"]);
});
