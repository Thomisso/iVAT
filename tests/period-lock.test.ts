import { expect, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import {
  approveDocument,
  correctDocument,
  documentPeriodLocks,
  listCompanyDocuments,
  listDocuments,
  listExtractionVersions,
  mergeDocuments,
  moveDocumentPage,
  rejectDocument,
  reprocessDocument,
  splitDocument,
  updateDocumentReporting,
} from "@/application/documents";
import { getCompany, updateCompanyIdentity } from "@/application/companies";
import { uploadSourceFile } from "@/application/source-files";
import {
  finalizeVatReport,
  generateVatReport,
  getPeriodLock,
  getVatReport,
  listVatReportTransitions,
  unlockReportingPeriod,
} from "@/application/vat-reports";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
  companyMember,
  companyWithManyApprovedReportDocuments,
  removeCompletedCompanyIdentityFixture,
} from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { systemClient, testWorker } from "./support/worker";

async function lockedCompanyWithDocuments({
  period = "2026-10",
}: {
  period?: string;
} = {}) {
  const company = await administratorWithCompany();
  const worker = testWorker();
  await enableAiProcessing(company.client, worker.jobs, {
    companyId: company.companyId,
    provider: worker.ai,
  });
  const upload = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "two-invoices.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  if (!upload.ok) throw new Error(upload.error);
  expect(await worker.runJobs()).toEqual([]);
  const documents = await listDocuments(company.client, company.companyId, upload.value.id);
  for (const document of documents) {
    expect(
      await approveDocument(company.client, {
        companyId: company.companyId,
        documentId: document.id,
        version: 1,
      }),
    ).toEqual({ ok: true, value: null });
  }
  const report = { companyId: company.companyId, period };
  expect((await generateVatReport(company.client, report)).ok).toBe(true);
  expect(await finalizeVatReport(company.client, { ...report, confirmed: true })).toEqual({ ok: true, value: null });
  return { ...company, documents, worker };
}

it("identifies every Document whose Reporting Period is locked for the workspace", async () => {
  const company = await lockedCompanyWithDocuments();
  expect(await documentPeriodLocks(
    company.client,
    company.companyId,
    company.documents.map((document) => document.id),
  )).toEqual(Object.fromEntries(company.documents.map((document) => [document.id, "2026-10"])));
});

it("preserves a newly uploaded Document for review when Extraction discovers a locked Reporting Period", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker();
  expect(await enableAiProcessing(company.client, worker.jobs, {
    companyId: company.companyId,
    provider: worker.ai,
  })).toEqual({ ok: true, value: null });
  const period = { companyId: company.companyId, period: "2026-10" };
  expect((await generateVatReport(company.client, period)).ok).toBe(true);
  expect(await finalizeVatReport(company.client, { ...period, confirmed: true })).toEqual({
    ok: true,
    value: null,
  });

  const upload = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "new-invoice.png",
    bytes: fixtureFile("receipt.png"),
  });
  if (!upload.ok) throw new Error(upload.error);

  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(company.client, company.companyId, upload.value.id);
  expect(document.status).toBe("needs_review");
  expect(await listExtractionVersions(company.client, company.companyId, document.id)).toEqual([
    expect.objectContaining({
      documentId: document.id,
      version: 1,
      payload: expect.objectContaining({ taxPointDate: "2026-10-01" }),
    }),
  ]);
  expect(await documentPeriodLocks(company.client, company.companyId, [document.id])).toEqual({
    [document.id]: "2026-10",
  });
  expect(await approveDocument(company.client, {
    companyId: company.companyId,
    documentId: document.id,
    version: 1,
  })).toEqual({ ok: false, error: "period_locked" });
  expect(await updateDocumentReporting(company.client, {
    companyId: company.companyId,
    documentId: document.id,
    claimedReportingPeriod: "2026-11",
  })).toEqual({ ok: false, error: "period_locked" });

  expect(await unlockReportingPeriod(company.client, {
    ...period,
    reason: "Review newly received Document",
    confirmed: true,
  })).toEqual({ ok: true, value: null });
  expect(await approveDocument(company.client, {
    companyId: company.companyId,
    documentId: document.id,
    version: 1,
  })).toEqual({ ok: true, value: null });
  expect(
    (await listDocuments(company.client, company.companyId, upload.value.id))[0].status,
  ).toBe("approved");
});

it("identifies locks beyond the configured PostgREST row limit", async () => {
  const company = await companyWithManyApprovedReportDocuments(1001);
  const input = { companyId: company.companyId, period: "2026-10" };
  expect((await generateVatReport(company.client, input)).ok).toBe(true);
  expect(await finalizeVatReport(company.client, { ...input, confirmed: true })).toEqual({ ok: true, value: null });
  const documents = await listCompanyDocuments(company.client, company.companyId);

  const locks = await documentPeriodLocks(
    company.client,
    company.companyId,
    documents.map((document) => document.id),
  );

  expect(documents).toHaveLength(1001);
  expect(Object.keys(locks)).toHaveLength(1001);
  expect(new Set(Object.values(locks))).toEqual(new Set(["2026-10"]));
}, 60_000);

it("only an Administrator finalizes and unlocks a stored VAT Report, and both transitions are audited", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const input = { companyId: company.companyId, period: "2026-10" };
  expect(await generateVatReport(company.client, input)).toEqual({
    ok: true,
    value: { id: expect.any(String) },
  });

  expect(await finalizeVatReport(user.client, { ...input, confirmed: true })).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(await finalizeVatReport(company.client, { ...input, confirmed: true })).toEqual({
    ok: true,
    value: null,
  });
  expect(await getPeriodLock(company.client, input.companyId, input.period)).toEqual(
    expect.objectContaining({
      companyId: input.companyId,
      period: input.period,
      lockedBy: company.userId,
      lockedAt: expect.any(String),
    }),
  );
  expect(await unlockReportingPeriod(user.client, {
    ...input,
    reason: "Correct source data",
    confirmed: true,
  })).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(await unlockReportingPeriod(company.client, {
    ...input,
    reason: "Correct source data",
    confirmed: true,
  })).toEqual({
    ok: true,
    value: null,
  });
  expect(await getPeriodLock(company.client, input.companyId, input.period)).toBeNull();

  const events = await listAuditEvents(company.client, company.organizationId);
  expect(events.filter((event) => event.action === "vat_report.finalized")).toEqual([
    expect.objectContaining({
      actorUserId: company.userId,
      companyId: company.companyId,
      targetType: "vat_report",
      payload: { period: input.period, warning_count: 0, rejected_document_count: 0 },
    }),
  ]);
  expect(events.filter((event) => event.action === "reporting_period.unlocked")).toEqual([
    expect.objectContaining({
      actorUserId: company.userId,
      companyId: company.companyId,
      targetType: "vat_report",
      payload: { period: input.period },
    }),
  ]);
  expect(await listVatReportTransitions(user.client, input.companyId, input.period)).toEqual([
    expect.objectContaining({
      action: "vat_report.finalized",
      actorUserId: company.userId,
      unlockReason: null,
    }),
    expect.objectContaining({
      action: "reporting_period.unlocked",
      actorUserId: company.userId,
      unlockReason: "Correct source data",
    }),
  ]);
});

it("keeps a period snapshot current after an unrelated Company setting changes", async () => {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-10" };
  expect((await generateVatReport(company.client, input)).ok).toBe(true);

  const worker = testWorker();
  expect(await enableAiProcessing(company.client, worker.jobs, {
    companyId: company.companyId,
    provider: worker.ai,
  })).toEqual({ ok: true, value: null });

  expect(await finalizeVatReport(company.client, { ...input, confirmed: true })).toEqual({
    ok: true,
    value: null,
  });
});

it("requires confirmation and refuses a stale snapshot, readiness blockers and incomplete identity", async () => {
  const stale = await administratorWithCompany();
  const staleInput = { companyId: stale.companyId, period: "2026-10" };
  const staleWorker = testWorker();
  expect(await enableAiProcessing(stale.client, staleWorker.jobs, {
    companyId: stale.companyId,
    provider: staleWorker.ai,
  })).toEqual({ ok: true, value: null });
  expect((await generateVatReport(stale.client, staleInput)).ok).toBe(true);
  expect(await finalizeVatReport(stale.client, { ...staleInput, confirmed: false })).toEqual({
    ok: false,
    error: "confirmation_required",
  });
  const staleUpload = await uploadSourceFile(stale.client, staleWorker.jobs, {
    companyId: stale.companyId,
    fileName: "new-source.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  expect(staleUpload.ok).toBe(true);
  expect(await staleWorker.runJobs()).toEqual([]);
  expect(await finalizeVatReport(stale.client, { ...staleInput, confirmed: true })).toEqual({
    ok: false,
    error: "stale_report",
  });

  const blocked = await administratorWithCompany("Blocked readiness");
  const worker = testWorker();
  await enableAiProcessing(blocked.client, worker.jobs, {
    companyId: blocked.companyId,
    provider: worker.ai,
  });
  const blockedUpload = await uploadSourceFile(blocked.client, worker.jobs, {
    companyId: blocked.companyId,
    fileName: "needs-review.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  if (!blockedUpload.ok) throw new Error(blockedUpload.error);
  expect(await worker.runJobs()).toEqual([]);
  const blockedInput = { companyId: blocked.companyId, period: "2026-10" };
  expect((await generateVatReport(blocked.client, blockedInput)).ok).toBe(true);
  expect(await finalizeVatReport(blocked.client, { ...blockedInput, confirmed: true })).toEqual({
    ok: false,
    error: "readiness_blocked",
  });

  const incomplete = await administratorWithCompany("Incomplete identity");
  const incompleteInput = { companyId: incomplete.companyId, period: "2026-10" };
  expect((await generateVatReport(incomplete.client, incompleteInput)).ok).toBe(true);
  await removeCompletedCompanyIdentityFixture(incomplete.companyId);
  expect(await finalizeVatReport(incomplete.client, { ...incompleteInput, confirmed: true })).toEqual({
    ok: false,
    error: "company_setup_incomplete",
  });
});

it("keeps rejected Documents separate from warnings in the confirmation summary", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker();
  await enableAiProcessing(company.client, worker.jobs, {
    companyId: company.companyId,
    provider: worker.ai,
  });
  const upload = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "warnings.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  if (!upload.ok) throw new Error(upload.error);
  expect(await worker.runJobs()).toEqual([]);
  const documents = await listDocuments(company.client, company.companyId, upload.value.id);
  expect(await approveDocument(company.client, {
    companyId: company.companyId,
    documentId: documents[0].id,
    version: 1,
  })).toEqual({ ok: true, value: null });
  expect(await rejectDocument(company.client, {
    companyId: company.companyId,
    documentId: documents[1].id,
  })).toEqual({ ok: true, value: null });

  const input = { companyId: company.companyId, period: "2026-10" };
  expect((await generateVatReport(company.client, input)).ok).toBe(true);
  expect(await getVatReport(company.client, input.companyId, input.period)).toEqual(
    expect.objectContaining({
      finalization: expect.objectContaining({
        blockerCount: 0,
        warningCount: 0,
        rejectedDocumentCount: 1,
      }),
    }),
  );
  expect(await finalizeVatReport(company.client, { ...input, confirmed: true })).toEqual({
    ok: true,
    value: null,
  });
});

it("requires an unlock reason and confirmation", async () => {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-10" };
  expect((await generateVatReport(company.client, input)).ok).toBe(true);
  expect(await finalizeVatReport(company.client, { ...input, confirmed: true })).toEqual({
    ok: true,
    value: null,
  });
  expect(await unlockReportingPeriod(company.client, {
    ...input,
    reason: "Correction",
    confirmed: false,
  })).toEqual({ ok: false, error: "confirmation_required" });
  expect(await unlockReportingPeriod(company.client, {
    ...input,
    reason: " ",
    confirmed: true,
  })).toEqual({ ok: false, error: "unlock_reason_required" });
  expect(await getPeriodLock(company.client, input.companyId, input.period)).not.toBeNull();
});

it("finalizes a Reporting Period again after it was unlocked and audits every transition", async () => {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-10" };
  expect(await generateVatReport(company.client, input)).toEqual({
    ok: true,
    value: { id: expect.any(String) },
  });

  expect(await finalizeVatReport(company.client, { ...input, confirmed: true })).toEqual({ ok: true, value: null });
  expect(await unlockReportingPeriod(company.client, {
    ...input,
    reason: "Regenerate after correction",
    confirmed: true,
  })).toEqual({ ok: true, value: null });
  const details = await getCompany(company.client, company.companyId);
  if (!details) throw new Error("Company not found");
  expect(await updateCompanyIdentity(company.client, {
    ...details,
    companyId: company.companyId,
    city: "Brno",
  })).toEqual({ ok: true, value: null });
  expect(await generateVatReport(company.client, input)).toEqual({
    ok: true,
    value: { id: expect.any(String) },
  });
  expect(await finalizeVatReport(company.client, { ...input, confirmed: true })).toEqual({ ok: true, value: null });
  expect(await getPeriodLock(company.client, input.companyId, input.period)).toEqual(
    expect.objectContaining({
      companyId: input.companyId,
      period: input.period,
      lockedBy: company.userId,
    }),
  );

  const transitions = (await listAuditEvents(company.client, company.organizationId))
    .filter((event) => event.action === "vat_report.finalized" || event.action === "reporting_period.unlocked");
  expect(transitions).toEqual([
    expect.objectContaining({ action: "vat_report.finalized" }),
    expect.objectContaining({ action: "reporting_period.unlocked", payload: {
      period: input.period,
    } }),
    expect.objectContaining({ action: "vat_report.finalized" }),
  ]);
});

it("keeps review commands inapplicable to the Approved Documents required by Finalization", async () => {
  const company = await lockedCompanyWithDocuments();
  const [version] = await listExtractionVersions(
    company.client,
    company.companyId,
    company.documents[0].id,
  );
  expect(
    await correctDocument(company.client, {
      companyId: company.companyId,
      documentId: company.documents[0].id,
      basedOnVersion: version.version,
      payload: version.payload,
    }),
  ).toEqual({ ok: false, error: "not_in_review" });
  expect(
    await approveDocument(company.client, {
      companyId: company.companyId,
      documentId: company.documents[0].id,
      version: 1,
    }),
  ).toEqual({ ok: false, error: "not_in_review" });
  expect(
    await rejectDocument(company.client, {
      companyId: company.companyId,
      documentId: company.documents[0].id,
    }),
  ).toEqual({ ok: false, error: "not_in_review" });
  expect(
    await reprocessDocument(company.client, company.worker.jobs, {
      companyId: company.companyId,
      documentId: company.documents[0].id,
    }),
  ).toEqual({ ok: false, error: "not_reprocessable" });
  expect(company.worker.queued).toEqual([]);
});

it("refuses merging Documents assigned to a locked Reporting Period", async () => {
  const company = await lockedCompanyWithDocuments();
  expect(
    await mergeDocuments(company.client, company.worker.jobs, {
      companyId: company.companyId,
      leftDocumentId: company.documents[0].id,
      rightDocumentId: company.documents[1].id,
    }),
  ).toEqual({ ok: false, error: "period_locked" });
});

it("refuses splitting a Document assigned to a locked Reporting Period", async () => {
  const company = await lockedCompanyWithDocuments();
  expect(
    await splitDocument(company.client, company.worker.jobs, {
      companyId: company.companyId,
      documentId: company.documents[0].id,
      splitAfterPage: company.documents[0].firstPage,
    }),
  ).toEqual({ ok: false, error: "period_locked" });
});

it("refuses moving a page between Documents assigned to a locked Reporting Period", async () => {
  const company = await lockedCompanyWithDocuments();
  expect(
    await moveDocumentPage(company.client, company.worker.jobs, {
      companyId: company.companyId,
      sourceDocumentId: company.documents[0].id,
      targetDocumentId: company.documents[1].id,
      page: company.documents[0].lastPage,
    }),
  ).toEqual({ ok: false, error: "period_locked" });
});

it("keeps the finalized VAT Report snapshot fixed until the period is unlocked", async () => {
  const company = await lockedCompanyWithDocuments();
  expect(
    await generateVatReport(company.client, {
      companyId: company.companyId,
      period: "2026-10",
    }),
  ).toEqual({ ok: false, error: "period_locked" });
});

it("refuses moving a Document out of a locked Reporting Period", async () => {
  const company = await lockedCompanyWithDocuments();
  expect(
    await updateDocumentReporting(company.client, {
      companyId: company.companyId,
      documentId: company.documents[0].id,
      claimedReportingPeriod: "2026-11",
    }),
  ).toEqual({ ok: false, error: "period_locked" });
});

it("refuses moving a Document into a locked Reporting Period", async () => {
  const company = await lockedCompanyWithDocuments({ period: "2026-11" });
  expect(
    await updateDocumentReporting(company.client, {
      companyId: company.companyId,
      documentId: company.documents[0].id,
      claimedReportingPeriod: "2026-11",
    }),
  ).toEqual({ ok: false, error: "period_locked" });
});

it("refuses deleting an Approved Document in a locked Reporting Period even to the privileged worker role", async () => {
  const company = await lockedCompanyWithDocuments();
  const deletion = await systemClient()
    .from("document")
    .delete()
    .eq("id", company.documents[0].id);
  expect(deletion.error?.code).toBe("42501");
  expect(
    await listDocuments(
      company.client,
      company.companyId,
      company.documents[0].sourceFileId,
    ),
  ).toContainEqual(expect.objectContaining({ id: company.documents[0].id, status: "approved" }));
});

it("isolates Period Lock and transition history reads and refuses direct user writes", async () => {
  const company = await lockedCompanyWithDocuments();
  const outsider = await administratorWithCompany("Other Organization");
  const own = await company.client.from("period_lock").select("*").eq("company_id", company.companyId).single();
  expect(own.error).toBeNull();
  expect(own.data).toEqual(expect.objectContaining({ company_id: company.companyId, period: "2026-10" }));
  const hidden = await outsider.client.from("period_lock").select("*").eq("company_id", company.companyId);
  expect(hidden.error).toBeNull();
  expect(hidden.data).toEqual([]);

  const ownTransitions = await company.client
    .from("vat_report_transition")
    .select("*")
    .eq("company_id", company.companyId);
  expect(ownTransitions.error).toBeNull();
  expect(ownTransitions.data).toEqual([
    expect.objectContaining({
      action: "vat_report.finalized",
      actor_user_id: company.userId,
      period: "2026-10",
    }),
  ]);
  const hiddenTransitions = await outsider.client
    .from("vat_report_transition")
    .select("*")
    .eq("company_id", company.companyId);
  expect(hiddenTransitions.error).toBeNull();
  expect(hiddenTransitions.data).toEqual([]);

  const row = own.data!;
  const transition = ownTransitions.data![0];
  const attempts = [
    await outsider.client.from("period_lock").insert(row),
    await outsider.client.from("period_lock").update({ period: "2026-11" }).eq("company_id", company.companyId),
    await outsider.client.from("period_lock").delete().eq("company_id", company.companyId),
    await outsider.client.from("vat_report_transition").insert({
      action: transition.action,
      actor_user_id: transition.actor_user_id,
      company_id: transition.company_id,
      organization_id: transition.organization_id,
      period: transition.period,
      unlock_reason: transition.unlock_reason,
      vat_report_id: transition.vat_report_id,
    }),
    await outsider.client.from("vat_report_transition").update({ period: "2026-11" }).eq("company_id", company.companyId),
    await outsider.client.from("vat_report_transition").delete().eq("company_id", company.companyId),
  ];
  for (const attempt of attempts) expect(attempt.error?.code).toBe("42501");
  expect(await getPeriodLock(company.client, company.companyId, "2026-10")).not.toBeNull();
});
