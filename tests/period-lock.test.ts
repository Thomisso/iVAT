import { expect, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import {
  approveDocument,
  correctDocument,
  listDocuments,
  listExtractionVersions,
  mergeDocuments,
  moveDocumentPage,
  rejectDocument,
  reprocessDocument,
  splitDocument,
  updateDocumentReporting,
} from "@/application/documents";
import { enableAiProcessing } from "@/application/companies";
import { uploadSourceFile } from "@/application/source-files";
import {
  finalizeVatReport,
  generateVatReport,
  getPeriodLock,
  unlockReportingPeriod,
} from "@/application/vat-reports";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { systemClient, testWorker } from "./support/worker";

async function lockedCompanyWithDocuments({
  approveFirst = false,
  period = "2026-10",
}: {
  approveFirst?: boolean;
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
    preselectedDirection: "incoming",
  });
  if (!upload.ok) throw new Error(upload.error);
  expect(await worker.runJobs()).toEqual([]);
  const documents = await listDocuments(company.client, company.companyId, upload.value.id);
  if (approveFirst) {
    expect(
      await approveDocument(company.client, {
        companyId: company.companyId,
        documentId: documents[0].id,
        version: 1,
      }),
    ).toEqual({ ok: true, value: null });
  }
  const report = { companyId: company.companyId, period };
  expect((await generateVatReport(company.client, report)).ok).toBe(true);
  expect(await finalizeVatReport(company.client, report)).toEqual({ ok: true, value: null });
  return { ...company, documents, worker };
}

it("only an Administrator finalizes and unlocks a stored VAT Report, and both transitions are audited", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const input = { companyId: company.companyId, period: "2026-10" };
  expect(await generateVatReport(company.client, input)).toEqual({
    ok: true,
    value: { id: expect.any(String) },
  });

  expect(await finalizeVatReport(user.client, input)).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(await finalizeVatReport(company.client, input)).toEqual({
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
  expect(await unlockReportingPeriod(user.client, input)).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(await unlockReportingPeriod(company.client, input)).toEqual({
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
      payload: { period: input.period },
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
});

it("refuses correcting a Document assigned to a locked Reporting Period", async () => {
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
  ).toEqual({ ok: false, error: "period_locked" });
});

it("refuses approving a Document assigned to a locked Reporting Period", async () => {
  const company = await lockedCompanyWithDocuments();
  expect(
    await approveDocument(company.client, {
      companyId: company.companyId,
      documentId: company.documents[0].id,
      version: 1,
    }),
  ).toEqual({ ok: false, error: "period_locked" });
});

it("refuses rejecting a Document assigned to a locked Reporting Period", async () => {
  const company = await lockedCompanyWithDocuments();
  expect(
    await rejectDocument(company.client, {
      companyId: company.companyId,
      documentId: company.documents[0].id,
    }),
  ).toEqual({ ok: false, error: "period_locked" });
});

it("refuses reprocessing a Document assigned to a locked Reporting Period", async () => {
  const company = await lockedCompanyWithDocuments();
  expect(
    await reprocessDocument(company.client, company.worker.jobs, {
      companyId: company.companyId,
      documentId: company.documents[0].id,
    }),
  ).toEqual({ ok: false, error: "period_locked" });
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
      receiptDate: company.documents[0].receiptDate,
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
      receiptDate: company.documents[0].receiptDate,
      claimedReportingPeriod: "2026-11",
    }),
  ).toEqual({ ok: false, error: "period_locked" });
});

it("refuses deleting an Approved Document in a locked Reporting Period even to the privileged worker role", async () => {
  const company = await lockedCompanyWithDocuments({ approveFirst: true });
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

it("isolates Period Lock reads and refuses direct user writes", async () => {
  const company = await lockedCompanyWithDocuments();
  const outsider = await administratorWithCompany("Other Organization");
  const own = await company.client.from("period_lock").select("*").eq("company_id", company.companyId).single();
  expect(own.error).toBeNull();
  expect(own.data).toEqual(expect.objectContaining({ company_id: company.companyId, period: "2026-10" }));
  const hidden = await outsider.client.from("period_lock").select("*").eq("company_id", company.companyId);
  expect(hidden.error).toBeNull();
  expect(hidden.data).toEqual([]);

  const row = own.data!;
  const attempts = [
    await outsider.client.from("period_lock").insert(row),
    await outsider.client.from("period_lock").update({ period: "2026-11" }).eq("company_id", company.companyId),
    await outsider.client.from("period_lock").delete().eq("company_id", company.companyId),
  ];
  for (const attempt of attempts) expect(attempt.error?.code).toBe("42501");
  expect(await getPeriodLock(company.client, company.companyId, "2026-10")).not.toBeNull();
});
