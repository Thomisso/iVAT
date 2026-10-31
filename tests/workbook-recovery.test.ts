import * as XLSX from "xlsx";
import { unzipSync, strFromU8 } from "fflate";
import { exportCompanyData } from "@/application/company-deletion";
import { promotedSuperAdministrator } from "./support/platform";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { finalizeVatReport, generateVatReport, getVatReport } from "@/application/vat-reports";
import { setCurrentReportingYear } from "@/application/companies";
import { pragueDate } from "@/application/reporting-periods";
import { expect, it } from "vitest";
import { multiSheetWorkbookFile } from "./support/files";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { defineSourceDocuments, getSourceFile, readSourceFile, readSourceWorkbook, excludeSourceFile, restoreSourceFile, retrySplit, startManualSourceReview, uploadSourceFile } from "@/application/source-files";
import { approveDocument, correctDocument, listDocuments, listExtractionVersions, readDocumentPages, readDocumentRows } from "@/application/documents";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { administratorWithCompany, assignAiConfigurationFixture, companyMember } from "./support/fixtures";
import { splitJob } from "@/application/processing";
import { testWorker, systemClient } from "./support/worker";

it.each(["xlsx", "xls"] as const)("a User recovers multiple sheets and row ranges from a failed %s without automatic AI or invented images", async (format) => {
  const context = await administratorWithCompany(); const user = await companyMember(context);
  const worker = testWorker(fakeAiProvider()); const bytes = multiSheetWorkbookFile(format);
  const uploaded = await uploadSourceFile(user.client, worker.jobs, { companyId: context.companyId, fileName: `manual.${format}`, bytes });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const failed = await systemClient().from("source_file").update({ status: "failed" }).eq("id", uploaded.value.id);
  if (failed.error) throw failed.error;
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id, ranges: [
    { sheetName: "Přijaté účty", firstRow: 2, lastRow: 2 },
    { sheetName: "Přijaté účty", firstRow: 3, lastRow: 4 },
    { sheetName: "Issued", firstRow: 2, lastRow: 3 },
  ] };
  const defined = await defineSourceDocuments(user.client, input);
  expect(defined.ok).toBe(true); if (!defined.ok) throw new Error(defined.error);
  const documents = await listDocuments(user.client, context.companyId, input.sourceFileId);
  expect(documents.map((document) => ({ rowSet: document.rowSet, image: document.hasDocumentImage, status: document.status }))).toEqual(expect.arrayContaining([
    { rowSet: { sheetName: "Přijaté účty", firstRow: 2, lastRow: 2 }, image: false, status: "needs_review" },
    { rowSet: { sheetName: "Issued", firstRow: 2, lastRow: 3 }, image: false, status: "needs_review" },
    { rowSet: { sheetName: "Přijaté účty", firstRow: 3, lastRow: 4 }, image: false, status: "needs_review" },
  ]));
  expect(documents).toHaveLength(3);
  const grouped = documents.find((document) => document.rowSet?.sheetName === "Přijaté účty" && document.rowSet.firstRow === 3)!;
  expect(await readDocumentRows(user.client, context.companyId, grouped.id)).toEqual({ fileName: `manual.${format}`, sheetName: "Přijaté účty", firstRow: 3, lastRow: 4, text: '[Sheet "Přijaté účty"]\n1\tDocument number\tGross amount\n3\tMANUAL-2\t242\n4\tMANUAL-3\t363' });
  for (const document of documents) {
    expect(await readDocumentPages(user.client, context.companyId, document.id)).toBeNull();
    expect(await listExtractionVersions(user.client, context.companyId, document.id)).toEqual([]);
    const target = { companyId: context.companyId, documentId: document.id, basedOnVersion: 0 };
    expect(await correctDocument(user.client, { ...target, payload: { ...SAMPLE_EXTRACTION, taxPointDate: null } })).toEqual({ ok: false, error: "tax_point_date_required" });
    expect(await correctDocument(user.client, { ...target, payload: SAMPLE_EXTRACTION })).toEqual({ ok: true, value: { version: 1 } });
    expect(await approveDocument(user.client, { companyId: context.companyId, documentId: document.id, version: 1 })).toEqual({ ok: true, value: null });
  }
  expect(await defineSourceDocuments(user.client, input)).toEqual(defined);
  await worker.jobs.send(splitJob(input.sourceFileId)); expect(await worker.runJobsConcurrently()).toEqual([]);
  expect((await listDocuments(user.client, context.companyId, input.sourceFileId)).map((document) => document.id).sort()).toEqual([...defined.value.documentIds].sort());
  expect((await readSourceFile(user.client, context.companyId, input.sourceFileId))?.bytes).toEqual(bytes);
  expect((await getSourceFile(user.client, context.companyId, input.sourceFileId))?.manualDefinition).toMatchObject({ userId: user.userId });
  expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
  const archived = await exportCompanyData(context.client, { async send() {} }, { companyId: context.companyId });
  if (!archived.ok) throw new Error(archived.error);
  const entries = unzipSync(archived.value.bytes);
  expect(entries[`source-files/${input.sourceFileId}/manual.${format}`]).toEqual(bytes);
  expect(JSON.parse(strFromU8(entries["source-files.json"]))[0].manualDefinition).toMatchObject({ userId: user.userId, ranges: input.ranges });
});

it.each([
  ["missing worksheet", [{ sheetName: "Missing", firstRow: 2, lastRow: 2 }]],
  ["case-changed worksheet", [{ sheetName: "issued", firstRow: 2, lastRow: 2 }]],
  ["row past actual worksheet", [{ sheetName: "Issued", firstRow: 2, lastRow: 4 }]],
  ["zero row", [{ sheetName: "Issued", firstRow: 0, lastRow: 1 }]],
  ["reversed range", [{ sheetName: "Issued", firstRow: 3, lastRow: 2 }]],
  ["fractional row", [{ sheetName: "Issued", firstRow: 2.5, lastRow: 3 }]],
  ["overlap across interleaved sheets", [{ sheetName: "Přijaté účty", firstRow: 2, lastRow: 3 }, { sheetName: "Issued", firstRow: 2, lastRow: 3 }, { sheetName: "Přijaté účty", firstRow: 3, lastRow: 4 }]],
  ["invented pages", [{ firstPage: 1, lastPage: 1 }]],
  ["empty ranges", []],
] as const)("manual workbook recovery refuses %s against the unchanged actual workbook", async (_name, ranges) => {
  const context = await administratorWithCompany(); const bytes = multiSheetWorkbookFile("xlsx");
  const uploaded = await uploadSourceFile(context.client, { async send() {} }, { companyId: context.companyId, fileName: "manual.xlsx", bytes });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await defineSourceDocuments(context.client, { companyId: context.companyId, sourceFileId: uploaded.value.id, ranges: [...ranges] })).toEqual({ ok: false, error: "invalid_workbook_ranges" });
  expect(await listDocuments(context.client, context.companyId, uploaded.value.id)).toEqual([]);
  expect((await getSourceFile(context.client, context.companyId, uploaded.value.id))?.status).toBe("uploaded");
  expect((await readSourceFile(context.client, context.companyId, uploaded.value.id))?.bytes).toEqual(bytes);
});

it("concurrent repeated workbook definitions preserve the same durable Documents and original ranges", async () => {
  const context = await administratorWithCompany();
  const uploaded = await uploadSourceFile(context.client, { async send() {} }, { companyId: context.companyId, fileName: "manual.xlsx", bytes: multiSheetWorkbookFile("xlsx") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id, ranges: [
    { sheetName: "Přijaté účty", firstRow: 2, lastRow: 2 }, { sheetName: "Issued", firstRow: 2, lastRow: 3 },
  ] };
  const [first, duplicate] = await Promise.all([defineSourceDocuments(context.client, input), defineSourceDocuments(context.client, input)]);
  expect(first.ok).toBe(true); expect(duplicate).toEqual(first);
  expect(await listDocuments(context.client, context.companyId, input.sourceFileId)).toHaveLength(2);
  expect(await defineSourceDocuments(context.client, { ...input, ranges: [{ sheetName: "Issued", firstRow: 1, lastRow: 3 }] })).toEqual({ ok: false, error: "source_already_resolved" });
});

it.each([
  [], null, {}, [{ sheetName: "Issued", firstRow: 2, lastRow: 3 }, { sheetName: "Issued", firstRow: 3, lastRow: 3 }],
  [{ sheetName: "Issued", firstRow: "2", lastRow: 3 }], [{ sheetName: "Issued", firstRow: 0, lastRow: 1 }],
  [{ sheetName: "Issued", firstRow: 3, lastRow: 2 }], [{ sheetName: "Issued", firstRow: 2, lastRow: null }],
  [{ firstPage: 1, lastPage: 1 }], [{ sheetName: "Issued", firstRow: 2, lastRow: 3, taxPointDate: "2026-10-15" }],
])("direct workbook RPC refuses malformed or overlapping range metadata %j atomically", async (ranges) => {
  const context = await administratorWithCompany();
  const uploaded = await uploadSourceFile(context.client, { async send() {} }, { companyId: context.companyId, fileName: "manual.xlsx", bytes: multiSheetWorkbookFile("xlsx") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const denied = await context.client.rpc("define_source_documents", { target_source_file_id: uploaded.value.id, document_ranges: ranges });
  expect(denied.error).toMatchObject({ code: "P0001", hint: "invalid_source_ranges" });
  expect(await listDocuments(context.client, context.companyId, uploaded.value.id)).toEqual([]);
  expect((await getSourceFile(context.client, context.companyId, uploaded.value.id))?.status).toBe("uploaded");
});

function gate() {
  let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it.each(["success", "failure"] as const)("late automatic workbook Split %s cannot undo manual row ownership or a User Version", async (outcome) => {
  const context = await administratorWithCompany(); const started = gate(); const finish = gate();
  const worker = testWorker(fakeAiProvider({ split: async () => {
    started.release(); await finish.promise;
    if (outcome === "failure") throw new Error("Late provider failure");
    return [{ sheetName: "Issued", firstRow: 1, lastRow: 3 }];
  } }));
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  const uploaded = await uploadSourceFile(context.client, worker.jobs, { companyId: context.companyId, fileName: "manual.xlsx", bytes: multiSheetWorkbookFile("xlsx") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id };
  const running = worker.runJobsConcurrently(); await started.promise;
  expect(await startManualSourceReview(context.client, input)).toEqual({ ok: true, value: null });
  const defined = await defineSourceDocuments(context.client, { ...input, ranges: [{ sheetName: "Přijaté účty", firstRow: 2, lastRow: 4 }] });
  if (!defined.ok) throw new Error(defined.error);
  const target = { companyId: context.companyId, documentId: defined.value.documentIds[0] };
  await correctDocument(context.client, { ...target, basedOnVersion: 0, payload: SAMPLE_EXTRACTION });
  await approveDocument(context.client, { ...target, version: 1 });
  finish.release(); await running;
  await worker.jobs.send(splitJob(input.sourceFileId)); expect(await worker.runJobsConcurrently()).toEqual([]);
  const documents = await listDocuments(context.client, context.companyId, input.sourceFileId);
  expect(documents).toEqual([expect.objectContaining({ id: target.documentId, rowSet: { sheetName: "Přijaté účty", firstRow: 2, lastRow: 4 }, status: "approved" })]);
  expect((await listExtractionVersions(context.client, context.companyId, target.documentId)).map((version) => version.author.kind)).toEqual(["user"]);
  expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
});

it("a workbook uses the same reasoned Source exclusion, reversal and readiness without a fictitious Document", async () => {
  const context = await administratorWithCompany(); const bytes = multiSheetWorkbookFile("xls");
  const uploaded = await uploadSourceFile(context.client, { async send() {} }, { companyId: context.companyId, fileName: "manual.xls", bytes });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id };
  const file = await getSourceFile(context.client, context.companyId, input.sourceFileId);
  if (!file) throw new Error("Source is missing");
  const period = pragueDate(file.uploadedAt).slice(0, 7);
  await setCurrentReportingYear(context.client, { companyId: context.companyId, filingFrequency: "monthly", year: Number(period.slice(0, 4)) });
  expect(await excludeSourceFile(context.client, { ...input, reason: "No accounting evidence in this workbook" })).toEqual({ ok: true, value: null });
  const resolved = await getReportingPeriodReadiness(context.client, { companyId: context.companyId, period });
  if (!resolved.ok) throw new Error(resolved.error);
  expect(resolved.value.ready).toBe(true); expect(resolved.value.groups.rejected).toEqual([]);
  expect(resolved.value.sourceFiles).toEqual([expect.objectContaining({ sourceFileId: input.sourceFileId, status: "rejected", exclusionReason: "No accounting evidence in this workbook" })]);
  expect(await listDocuments(context.client, context.companyId, input.sourceFileId)).toEqual([]);
  expect(await restoreSourceFile(context.client, input)).toEqual({ ok: true, value: null });
  const pending = await getReportingPeriodReadiness(context.client, { companyId: context.companyId, period });
  if (!pending.ok) throw new Error(pending.error);
  expect(pending.value.ready).toBe(false);
  expect(pending.value.sourceFiles).toEqual([expect.objectContaining({ sourceFileId: input.sourceFileId, status: "needs_review" })]);
  expect((await defineSourceDocuments(context.client, { ...input, ranges: [{ sheetName: "Issued", firstRow: 2, lastRow: 3 }] })).ok).toBe(true);
  expect((await readSourceFile(context.client, context.companyId, input.sourceFileId))?.bytes).toEqual(bytes);
});

it("locked workbook Source snapshots refuse manual definition, retry and reversal through both application and RPC", async () => {
  const context = await administratorWithCompany();
  const uploaded = await uploadSourceFile(context.client, { async send() {} }, { companyId: context.companyId, fileName: "manual.xlsx", bytes: multiSheetWorkbookFile("xlsx") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id };
  const file = await getSourceFile(context.client, context.companyId, input.sourceFileId);
  if (!file) throw new Error("Source is missing");
  const period = pragueDate(file.uploadedAt).slice(0, 7);
  await setCurrentReportingYear(context.client, { companyId: context.companyId, filingFrequency: "monthly", year: Number(period.slice(0, 4)) });
  await excludeSourceFile(context.client, { ...input, reason: "Resolved workbook" });
  expect((await generateVatReport(context.client, { companyId: context.companyId, period })).ok).toBe(true);
  expect(await finalizeVatReport(context.client, { companyId: context.companyId, period, confirmed: true })).toEqual({ ok: true, value: null });
  const before = await getVatReport(context.client, context.companyId, period);
  const ranges = [{ sheetName: "Issued", firstRow: 2, lastRow: 3 }];
  expect(await defineSourceDocuments(context.client, { ...input, ranges })).toEqual({ ok: false, error: "period_locked" });
  expect(await restoreSourceFile(context.client, input)).toEqual({ ok: false, error: "period_locked" });
  expect(await retrySplit(context.client, { async send() {} }, input)).toEqual({ ok: false, error: "period_locked" });
  expect((await context.client.rpc("define_source_documents", { target_source_file_id: input.sourceFileId, document_ranges: ranges })).error?.hint).toBe("period_locked");
  expect(await listDocuments(context.client, context.companyId, input.sourceFileId)).toEqual([]);
  expect(await getVatReport(context.client, context.companyId, period)).toEqual(before);
});

it("foreign actors cannot read workbook evidence or claim ranges; SuperAdmin access still works without Membership", async () => {
  const context = await administratorWithCompany(); const foreign = await administratorWithCompany();
  const superAdmin = await promotedSuperAdministrator("Workbook recovery platform");
  const uploaded = await uploadSourceFile(context.client, { async send() {} }, { companyId: context.companyId, fileName: "manual.xlsx", bytes: multiSheetWorkbookFile("xlsx") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id, ranges: [{ sheetName: "Issued", firstRow: 2, lastRow: 3 }] };
  expect(await readSourceWorkbook(foreign.client, context.companyId, input.sourceFileId)).toBeNull();
  expect(await defineSourceDocuments(foreign.client, input)).toEqual({ ok: false, error: "forbidden" });
  expect((await foreign.client.rpc("define_source_documents", { target_source_file_id: input.sourceFileId, document_ranges: input.ranges })).error?.code).toBe("42501");
  expect(await listDocuments(context.client, context.companyId, input.sourceFileId)).toEqual([]);
  expect((await defineSourceDocuments(superAdmin.client, input)).ok).toBe(true);
  expect(await listDocuments(context.client, context.companyId, input.sourceFileId)).toEqual([expect.objectContaining({ rowSet: { sheetName: "Issued", firstRow: 2, lastRow: 3 }, status: "needs_review" })]);
});

it("manual worksheet bounds follow actual populated row positions rather than an invented first row", async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, { "!ref": "B4:C5", B4: { t: "s", v: "Document number" }, C4: { t: "s", v: "Gross amount" }, B5: { t: "s", v: "OFFSET-1" }, C5: { t: "n", v: 121 } }, "Offset");
  const bytes = new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
  const context = await administratorWithCompany();
  const uploaded = await uploadSourceFile(context.client, { async send() {} }, { companyId: context.companyId, fileName: "offset.xlsx", bytes });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id };
  expect(await readSourceWorkbook(context.client, context.companyId, input.sourceFileId)).toEqual({ text: '[Sheet "Offset"]\n4\tDocument number\tGross amount\n5\tOFFSET-1\t121', rowSets: [{ sheetName: "Offset", firstRow: 4, lastRow: 5 }] });
  expect(await defineSourceDocuments(context.client, { ...input, ranges: [{ sheetName: "Offset", firstRow: 3, lastRow: 5 }] })).toEqual({ ok: false, error: "invalid_workbook_ranges" });
  expect((await defineSourceDocuments(context.client, { ...input, ranges: [{ sheetName: "Offset", firstRow: 5, lastRow: 5 }] })).ok).toBe(true);
});
