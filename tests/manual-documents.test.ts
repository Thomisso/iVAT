import { reportingWorkbookCopy } from "./support/reporting-workbook-copy";
import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { approveDocument, correctDocument, createManualDocument, getDocument, listCompanyDocuments, listExtractionVersions, mergeDocuments, moveDocumentPage, readDocumentPages, readDocumentRows, reprocessDocument, splitDocument, updateDocumentReporting } from "@/application/documents";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { listSourceFiles } from "@/application/source-files";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { finalizeVatReport, generateVatReport, getVatReport, unlockReportingPeriod } from "@/application/vat-reports";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { testWorker } from "./support/worker";
import { strFromU8, unzipSync } from "fflate";
import { exportCompanyData, getCompanyDataExportStatus } from "@/application/company-deletion";
import { emptyDocumentPayload } from "@/application/extraction-payload";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { promotedSuperAdministrator } from "./support/platform";
import { exportReportingPeriodWorkbook } from "@/application/reporting-period-excel";
import * as XLSX from "xlsx";

it("a Company User creates a Document with a real authored Version and no invented source evidence", async () => {
  const administrator = await administratorWithCompany();
  const user = await companyMember(administrator);
  const before = await getCompanyAiProcessingAllowance(user.client, administrator.companyId);
  const created = await createManualDocument(user.client, {
    companyId: administrator.companyId,
    payload: SAMPLE_EXTRACTION,
  });
  if (!created.ok) throw new Error(created.error);
  const document = await getDocument(user.client, administrator.companyId, created.value.id);
  expect(document).toMatchObject({ sourceFileId: null, firstPage: null, lastPage: null, importDate: null, status: "needs_review" });
  const versions = await listExtractionVersions(user.client, administrator.companyId, created.value.id);
  expect(versions).toHaveLength(1);
  expect(versions[0]).toMatchObject({ version: 1, author: { kind: "user", userId: user.userId }, payload: { documentNumber: "FV-2026-0001" } });
  expect(versions[0].createdAt).toBe(document?.createdAt);
  expect(await listSourceFiles(user.client, administrator.companyId)).toEqual([]);
  expect(await listCompanyDocuments(user.client, administrator.companyId)).toMatchObject([{ id: created.value.id, importDate: null, reportingPeriod: "2026-10" }]);
  expect(await getCompanyAiProcessingAllowance(user.client, administrator.companyId)).toEqual(before);
});

it("requires a real Tax Point Date on creation and every manual correction, including direct database commands", async () => {
  const administrator = await administratorWithCompany();
  for (const [taxPointDate, error] of [[null, "tax_point_date_required"], ["2026-02-30", "invalid_date"]] as const) {
    expect(await createManualDocument(administrator.client, { companyId: administrator.companyId, payload: { ...SAMPLE_EXTRACTION, taxPointDate } }))
      .toEqual({ ok: false, error });
    const direct = await administrator.client.rpc("create_manual_document", {
      target_company_id: administrator.companyId, payload: { ...SAMPLE_EXTRACTION, taxPointDate }, findings: [],
    });
    expect(direct.error).toMatchObject({ code: "P0001", hint: error });
  }
  const created = await createManualDocument(administrator.client, { companyId: administrator.companyId, payload: SAMPLE_EXTRACTION });
  if (!created.ok) throw new Error(created.error);
  expect(await correctDocument(administrator.client, {
    companyId: administrator.companyId, documentId: created.value.id, basedOnVersion: 1,
    payload: { ...SAMPLE_EXTRACTION, taxPointDate: null },
  })).toEqual({ ok: false, error: "tax_point_date_required" });
  const directCorrection = await administrator.client.rpc("correct_document", {
    target_document_id: created.value.id, based_on_version: 1,
    payload: { ...SAMPLE_EXTRACTION, taxPointDate: null }, findings: [],
  });
  expect(directCorrection.error).toMatchObject({ code: "P0001", hint: "tax_point_date_required" });
  expect(await listExtractionVersions(administrator.client, administrator.companyId, created.value.id)).toHaveLength(1);
});

it("preserves unfinished Credit Note amounts and Rate Breakdown until a complete version can be approved", async () => {
  const administrator = await administratorWithCompany();
  const payload: ExtractionPayload = {
    ...SAMPLE_EXTRACTION, documentType: "credit_note",
    rateBreakdown: [{ rate: null, netAmount: "-100.00", vatAmount: null }],
    totals: { netAmount: null, vatAmount: null, grossAmount: null },
  };
  const created = await createManualDocument(administrator.client, { companyId: administrator.companyId, payload });
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: administrator.companyId, documentId: created.value.id };
  expect((await listExtractionVersions(administrator.client, input.companyId, input.documentId))[0].payload).toMatchObject({
    schemaVersion: 2, documentType: "credit_note", rateBreakdown: [{ rate: null, netAmount: "-100.00", vatAmount: null }],
    totals: { netAmount: null, vatAmount: null, grossAmount: null },
  });
  expect(await approveDocument(administrator.client, { ...input, version: 1 })).toEqual({ ok: false, error: "document_incomplete" });
  const complete: ExtractionPayload = {
    ...payload,
    rateBreakdown: [{ rate: 21, netAmount: "-100.00", vatAmount: "-21.00" }],
    totals: { netAmount: "-100.00", vatAmount: "-21.00", grossAmount: "-121.00" },
  };
  expect(await correctDocument(administrator.client, { ...input, basedOnVersion: 1, payload: complete })).toEqual({ ok: true, value: { version: 2 } });
  expect(await approveDocument(administrator.client, { ...input, version: 2 })).toEqual({ ok: true, value: null });
});

it("preserves a first manual draft pointing into a Period Lock without changing its saved report", async () => {
  const administrator = await administratorWithCompany();
  const period = { companyId: administrator.companyId, period: "2026-09" };
  expect((await generateVatReport(administrator.client, period)).ok).toBe(true);
  expect(await finalizeVatReport(administrator.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
  const before = await getVatReport(administrator.client, period.companyId, period.period);
  const payload = { ...SAMPLE_EXTRACTION, taxPointDate: "2026-09-15" };
  const created = await createManualDocument(administrator.client, { companyId: administrator.companyId, payload });
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: administrator.companyId, documentId: created.value.id };
  expect((await getDocument(administrator.client, input.companyId, input.documentId))?.status).toBe("needs_review");
  expect(await approveDocument(administrator.client, { ...input, version: 1 })).toEqual({ ok: false, error: "period_locked" });
  expect(await correctDocument(administrator.client, { ...input, basedOnVersion: 1, payload })).toEqual({ ok: false, error: "period_locked" });
  expect(await getVatReport(administrator.client, period.companyId, period.period)).toEqual(before);
  expect(await unlockReportingPeriod(administrator.client, { ...period, confirmed: true, reason: "Review the new manual evidence" }))
    .toEqual({ ok: true, value: null });
  expect(await approveDocument(administrator.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
});

it("does not request file-dependent AI work or invent a viewer for a source-independent Document", async () => {
  const administrator = await administratorWithCompany();
  const created = await createManualDocument(administrator.client, { companyId: administrator.companyId, payload: SAMPLE_EXTRACTION });
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: administrator.companyId, documentId: created.value.id };
  const worker = testWorker();
  expect(await readDocumentPages(administrator.client, input.companyId, input.documentId)).toBeNull();
  expect(await readDocumentRows(administrator.client, input.companyId, input.documentId)).toBeNull();
  expect(await reprocessDocument(administrator.client, worker.jobs, input)).toEqual({ ok: false, error: "not_reprocessable" });
  const direct = await administrator.client.rpc("reprocess_document", { target_document_id: input.documentId });
  expect(direct.error).toMatchObject({ code: "P0001", hint: "not_reprocessable" });
  expect(worker.queued).toEqual([]);
  expect((await getDocument(administrator.client, input.companyId, input.documentId))?.status).toBe("needs_review");
});

it("keeps a DUZP-only draft visible and preserves nullable version-2 values in a completed Company archive", async () => {
  const administrator = await administratorWithCompany();
  const created = await createManualDocument(administrator.client, {
    companyId: administrator.companyId,
    payload: { ...emptyDocumentPayload(), taxPointDate: "2026-10-15", rateBreakdown: [{ rate: 21, netAmount: "100.00", vatAmount: null }] },
  });
  if (!created.ok) throw new Error(created.error);
  expect(await listCompanyDocuments(administrator.client, administrator.companyId, { status: "needs_review" }))
    .toMatchObject([{ id: created.value.id, reportingPeriod: "2026-10", grossAmount: null, direction: null, sourceFileId: null }]);
  const readiness = await getReportingPeriodReadiness(administrator.client, { companyId: administrator.companyId, period: "2026-10" });
  expect(readiness.ok && readiness.value.groups.needsReview).toEqual([created.value.id]);
  expect(readiness.ok && readiness.value.ready).toBe(false);
  const workbookResult = await exportReportingPeriodWorkbook(administrator.client, { companyId: administrator.companyId, period: "2026-10" }, reportingWorkbookCopy());
  if (!workbookResult.ok) throw new Error(workbookResult.error);
  const workbook = XLSX.read(workbookResult.value.bytes, { type: "array" });
  expect(XLSX.utils.sheet_to_json(workbook.Sheets.Attention, { defval: "" })).toMatchObject([{
    "Document ID": created.value.id, "VAT rate (%)": 21, "Net amount": 100, "VAT amount": "", "Gross amount": "",
  }]);
  const worker = testWorker();
  const exported = await exportCompanyData(administrator.client, worker.jobs, { companyId: administrator.companyId });
  if (!exported.ok) throw new Error(exported.error);
  expect(await worker.runJobs()).toEqual([]);
  expect(await getCompanyDataExportStatus(administrator.client, { companyId: administrator.companyId, exportId: exported.value.exportId }))
    .toEqual({ ok: true, value: "completed" });
  const files = unzipSync(exported.value.bytes);
  expect(JSON.parse(strFromU8(files["source-files.json"]))).toEqual([]);
  expect(JSON.parse(strFromU8(files["documents.json"]))).toMatchObject([{
    id: created.value.id, sourceFileId: null, firstPage: null, lastPage: null,
    extractionVersions: [{ author: { kind: "user", userId: administrator.userId }, payload: {
      schemaVersion: 2, rateBreakdown: [{ rate: 21, netAmount: "100.00", vatAmount: null }],
    } }],
  }]);
});

it("enforces tenant isolation for manual creation, correction and direct reads while retaining SuperAdmin scope", async () => {
  const administrator = await administratorWithCompany();
  const other = await administratorWithCompany();
  const created = await createManualDocument(administrator.client, { companyId: administrator.companyId, payload: SAMPLE_EXTRACTION });
  if (!created.ok) throw new Error(created.error);
  expect(await createManualDocument(other.client, { companyId: administrator.companyId, payload: SAMPLE_EXTRACTION }))
    .toEqual({ ok: false, error: "forbidden" });
  expect(await getDocument(other.client, administrator.companyId, created.value.id)).toBeNull();
  expect(await correctDocument(other.client, { companyId: administrator.companyId, documentId: created.value.id, basedOnVersion: 1, payload: SAMPLE_EXTRACTION }))
    .toEqual({ ok: false, error: "forbidden" });
  const direct = await other.client.from("document").select("id").eq("id", created.value.id);
  expect(direct.data).toEqual([]);
  const operator = await promotedSuperAdministrator("Manual Documents platform scope");
  const platformCreated = await createManualDocument(operator.client, { companyId: administrator.companyId, payload: SAMPLE_EXTRACTION });
  expect(platformCreated.ok).toBe(true);
  if (!platformCreated.ok) throw new Error(platformCreated.error);
  expect((await listExtractionVersions(operator.client, administrator.companyId, platformCreated.value.id))[0].author)
    .toEqual({ kind: "user", userId: operator.userId });
});

it("requires report-critical counterparty identity even when a small domestic draft has only advisory findings", async () => {
  const administrator = await administratorWithCompany();
  const created = await createManualDocument(administrator.client, {
    companyId: administrator.companyId,
    payload: { ...SAMPLE_EXTRACTION, supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: null } },
  });
  if (!created.ok) throw new Error(created.error);
  expect(await approveDocument(administrator.client, { companyId: administrator.companyId, documentId: created.value.id, version: 1 }))
    .toEqual({ ok: false, error: "counterparty_vat_id_required" });
});

it("reports complete source-independent data in its DUZP period and preserves an incoming Deferred Claim", async () => {
  const administrator = await administratorWithCompany();
  const created = await createManualDocument(administrator.client, { companyId: administrator.companyId, payload: SAMPLE_EXTRACTION });
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: administrator.companyId, documentId: created.value.id };
  expect(await approveDocument(administrator.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
  expect((await generateVatReport(administrator.client, { companyId: input.companyId, period: "2026-10" })).ok).toBe(true);
  expect((await getVatReport(administrator.client, input.companyId, "2026-10"))?.result.totals.inputVat).toBe("210.00");
  expect(await updateDocumentReporting(administrator.client, { ...input, claimedReportingPeriod: "2026-11" })).toEqual({ ok: true, value: null });
  expect((await generateVatReport(administrator.client, { companyId: input.companyId, period: "2026-10" })).ok).toBe(true);
  expect((await generateVatReport(administrator.client, { companyId: input.companyId, period: "2026-11" })).ok).toBe(true);
  expect((await getVatReport(administrator.client, input.companyId, "2026-10"))?.result.totals.inputVat).toBe("0.00");
  expect((await getVatReport(administrator.client, input.companyId, "2026-11"))?.result.vatReturn).toContainEqual({
    line: "40", netAmount: "1000.00", vatAmount: "210.00", documentIds: [input.documentId],
  });
});

it("does not apply Credit Note sign rules to a Document whose optional type remains undetermined", async () => {
  const administrator = await administratorWithCompany();
  const created = await createManualDocument(administrator.client, {
    companyId: administrator.companyId, payload: { ...SAMPLE_EXTRACTION, documentType: null },
  });
  if (!created.ok) throw new Error(created.error);
  expect(await approveDocument(administrator.client, { companyId: administrator.companyId, documentId: created.value.id, version: 1 }))
    .toEqual({ ok: true, value: null });
});

it("refuses inconsistent VAT arithmetic at the database approval boundary even when supplied findings are empty", async () => {
  const administrator = await administratorWithCompany();
  const direct = await administrator.client.rpc("create_manual_document", {
    target_company_id: administrator.companyId,
    payload: { ...SAMPLE_EXTRACTION, rateBreakdown: [{ rate: 21, netAmount: "100.00", vatAmount: "20.00" }],
      totals: { netAmount: "100.00", vatAmount: "20.00", grossAmount: "120.00" } },
    findings: [],
  });
  expect(direct.error).toBeNull();
  const approval = await administrator.client.rpc("approve_document", { target_document_id: direct.data!, reviewed_version: 1 });
  expect(approval.error).toMatchObject({ code: "P0001", hint: "document_validation_failed" });
});

it.each(["merge", "split", "move"] as const)("refuses %s through commands and RPCs without losing either manual Document or its history", async (operation) => {
  const administrator = await administratorWithCompany();
  const ids: string[] = [];
  for (const documentNumber of ["MANUAL-LEFT", "MANUAL-RIGHT"]) {
    const result = await createManualDocument(administrator.client, {
      companyId: administrator.companyId, payload: { ...SAMPLE_EXTRACTION, documentNumber },
    });
    if (!result.ok) throw new Error(result.error);
    ids.push(result.value.id);
  }
  const beforeDocuments = await Promise.all(ids.map((id) => getDocument(administrator.client, administrator.companyId, id)));
  const beforeVersions = await Promise.all(ids.map((id) => listExtractionVersions(administrator.client, administrator.companyId, id)));
  const beforeList = await listCompanyDocuments(administrator.client, administrator.companyId);
  const worker = testWorker();
  const input = { companyId: administrator.companyId };
  const result = operation === "merge"
    ? await mergeDocuments(administrator.client, worker.jobs, { ...input, leftDocumentId: ids[0], rightDocumentId: ids[1] })
    : operation === "split"
      ? await splitDocument(administrator.client, worker.jobs, { ...input, documentId: ids[0], splitAfterPage: 1 })
      : await moveDocumentPage(administrator.client, worker.jobs, { ...input, sourceDocumentId: ids[0], targetDocumentId: ids[1], page: 1 });
  expect(result).toEqual({ ok: false, error: "not_correctable" });
  const direct = operation === "merge"
    ? await administrator.client.rpc("merge_documents", { left_document_id: ids[0], right_document_id: ids[1] })
    : operation === "split"
      ? await administrator.client.rpc("split_document", { target_document_id: ids[0], split_after_page: 1 })
      : await administrator.client.rpc("move_document_page", { source_document_id: ids[0], target_document_id: ids[1], page: 1 });
  expect(direct.error).toMatchObject({ code: "P0001", hint: "not_correctable" });
  expect(await Promise.all(ids.map((id) => getDocument(administrator.client, administrator.companyId, id)))).toEqual(beforeDocuments);
  expect(await Promise.all(ids.map((id) => listExtractionVersions(administrator.client, administrator.companyId, id)))).toEqual(beforeVersions);
  expect(await listCompanyDocuments(administrator.client, administrator.companyId)).toEqual(beforeList);
  expect(worker.queued).toEqual([]);
});
