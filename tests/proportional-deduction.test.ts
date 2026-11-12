import * as XLSX from "xlsx";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { exportFinalVatReport, readVatReportArtifact } from "@/application/epo-export";
import { createVatReturnPdf } from "@/application/vat-return-pdf";
import { createControlStatementPdf } from "@/application/control-statement-pdf";
import { vatReturnPreviewData } from "@/application/vat-return-preview";
import { prepareControlStatement } from "@/application/epo-values";
import { exportReportingPeriodWorkbook } from "@/application/reporting-period-excel";
import { reportingWorkbookCopy } from "./support/reporting-workbook-copy";
import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { saveAndApproveDocument, listExtractionVersions } from "@/application/documents";
import { finalizeVatReport, generateVatReport, getVatReport } from "@/application/vat-reports";
import { createEpoXml, type ExportDetails } from "@/application/epo-xml";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany } from "./support/fixtures";
import { createConfirmedManualDocument } from "./support/claim-eligibility";

const source = { ...SAMPLE_EXTRACTION,
  rateBreakdown: [{ rate: 21, netAmount: "12000.00", vatAmount: "2520.00" }],
  totals: { netAmount: "12000.00", vatAmount: "2520.00", grossAmount: "14520.00" },
};
const ratio = { percentage: 50, confirmed: true, operatingExpenseConfirmed: true, actualUseConfirmed: true, origin: "user" as const };
const registry = fakeVatPayerRegistry();
const details: ExportDetails = { taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", preparedOn: "2026-10-27", personType: "P", email: "qa@example.test", phone: "", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka" };

it("a manual proportional decision survives approval and a saved B.2 report with A and independently reduced amounts", async () => {
  const company = await administratorWithCompany();
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: source }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...source, proportionalDeduction: ratio } }, undefined, registry))
    .toEqual({ ok: true, value: { version: 2 } });
  const versions = await listExtractionVersions(company.client, input.companyId, input.documentId);
  expect(versions[1].payload).toMatchObject({ totals: source.totals, proportionalDeduction: ratio });
  expect((await generateVatReport(company.client, { companyId: input.companyId, period: "2026-10" })).ok).toBe(true);
  const report = await getVatReport(company.client, input.companyId, "2026-10");
  expect(report?.result.vatReturn.find(line => line.line === "40")).toMatchObject({ netAmount: "6000.00", vatAmount: "1260.00" });
  expect(report?.result.controlStatement).toMatchObject([{ section: "B.2", proportionalDeduction: true, rateBreakdown: [{ netAmount: "6000.00", vatAmount: "1260.00" }] }]);
  const xml = await createEpoXml(report!.result, "dphkh1", details);
  expect(xml.ok && xml.value).toMatch(/<VetaB2\b[^>]*pomer="A"[^>]*zakl_dane1="6000\.00" dan1="1260\.00"/);
});

it("final XML artifacts, statutory PDF and workbook reconcile a proportional claim to its immutable source", async () => {
  const company = await administratorWithCompany();
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: source }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  expect(await saveAndApproveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, basedOnVersion: 1,
    requestId: crypto.randomUUID(), payload: { ...source, proportionalDeduction: ratio } }, undefined, registry)).toMatchObject({ ok: true });
  expect((await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" })).ok).toBe(true);
  const report = (await getVatReport(company.client, company.companyId, "2026-10"))!;
  const workbook = await exportReportingPeriodWorkbook(company.client, { companyId: company.companyId, period: "2026-10" }, reportingWorkbookCopy());
  if (!workbook.ok) throw new Error(workbook.error);
  const book = XLSX.read(workbook.value.bytes, { type: "array" });
  const rows = XLSX.utils.sheet_to_json(book.Sheets.Included);
  expect(rows).toMatchObject([{ "Net amount": 12000, "VAT amount": 2520, "Deduction mode": "proportional", "Ratio (%)": 50,
    "Claimed net amount": 6000, "Claimed VAT amount": 1260, "Unclaimed net amount": 6000, "Unclaimed VAT amount": 1260 }]);
  expect(await finalizeVatReport(company.client, { companyId: company.companyId, period: "2026-10", confirmed: true })).toEqual({ ok: true, value: null });
  for (const format of ["dphdp3", "dphkh1"]) {
    const exported = await exportFinalVatReport(company.client, { companyId: company.companyId, period: "2026-10", format,
      details: Object.fromEntries(Object.entries(details).filter(([, value]) => typeof value === "string")) as Record<string, string> });
    if (!exported.ok) throw new Error(exported.error);
    const stored = await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: exported.value.artifactId });
    expect(stored?.bytes).toEqual(exported.value.bytes);
    expect(new TextDecoder().decode(stored!.bytes)).toMatch(format === "dphkh1" ? /pomer="A"/ : /pln23="6000" odp_tuz23_nar="1260"/);
  }
  async function text(bytes: Uint8Array) {
    const task = getDocument({ data: Uint8Array.from(bytes) });
    try { const pdf = await task.promise; return (await Promise.all(Array.from({ length: pdf.numPages }, async (_, i) =>
      (await (await pdf.getPage(i + 1)).getTextContent()).items.flatMap(item => "str" in item ? [item.str] : []).join(" ")))).join("\n"); }
    finally { await task.destroy(); }
  }
  expect(await text(await createVatReturnPdf(vatReturnPreviewData(report.result)))).toMatch(/6000\s+1260/);
  expect(await text(await createControlStatementPdf({ company: report.result.company, period: report.period, details }, prepareControlStatement(report.result))))
    .toMatch(/6000.00\s+1260.00[\s\S]*A/);
});

it.each([false, true])("the special annual boundary permits later periods in the earliest year and refuses the next year (quarterly=%s)", async quarterly => {
  const company = await administratorWithCompany();
  const { generateReportingYears, changeReportingYearFrequency } = await import("@/application/reporting-years");
  const { createManualDocument, updateDocumentReporting, listDeferredClaimPeriods } = await import("@/application/documents");
  if (quarterly) expect(await changeReportingYearFrequency(company.client, { companyId: company.companyId, year: 2026, frequency: "quarterly" })).toMatchObject({ ok: true });
  expect(await generateReportingYears(company.client, { companyId: company.companyId, fromYear: 2027, toYear: 2027, frequency: quarterly ? "quarterly" : "monthly" })).toMatchObject({ ok: true });
  const payload = { ...source, taxPointDate: quarterly ? "2026-01-10" : "2026-10-01", issueDate: quarterly ? "2026-01-10" : "2026-10-01",
    proportionalDeduction: ratio, claimEligibility: { period: quarterly ? "2026-Q1" : "2026-10", origin: "user" as const, confirmed: true } };
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await listDeferredClaimPeriods(company.client, input.companyId, input.documentId)).not.toContain(quarterly ? "2027-Q1" : "2027-01");
  for (const period of quarterly ? ["2026-Q3", "2026-Q4"] : ["2026-11", "2026-12"]) {
    expect(await updateDocumentReporting(company.client, { ...input, claimedReportingPeriod: period })).toEqual({ ok: true, value: null });
  }
  expect(await updateDocumentReporting(company.client, { ...input, claimedReportingPeriod: quarterly ? "2027-Q1" : "2027-01" }))
    .toEqual({ ok: false, error: "proportional_claim_year_mismatch" });
  expect((await company.client.rpc("update_document_reporting", { target_document_id: input.documentId, new_claimed_reporting_period: quarterly ? "2027-Q1" : "2027-01" })).error)
    .toMatchObject({ code: "P0001", hint: "proportional_claim_year_mismatch" });
});

it.each([
  { percentage: null }, { percentage: 0 }, { percentage: 100 }, { percentage: -1 }, { percentage: 60.5 }, { percentage: "60" },
  { confirmed: false }, { operatingExpenseConfirmed: false }, { actualUseConfirmed: false }, { origin: "ai" }, { method: "section76" },
])("invalid or unconfirmed manual ratios cannot bypass the database approval guard (%j)", async invalid => {
  const company = await administratorWithCompany();
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: source }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  expect((await company.client.rpc("correct_document", { target_document_id: created.value.id, based_on_version: 1,
    payload: { ...source, proportionalDeduction: { ...ratio, ...invalid } }, findings: [] })).error).toBeNull();
  expect((await company.client.rpc("approve_document", { target_document_id: created.value.id, reviewed_version: 2 })).error)
    .toMatchObject({ code: "P0001", hint: "document_validation_failed" });
  const { getDocumentReview } = await import("@/application/document-review");
  expect((await getDocumentReview(company.client, { companyId: company.companyId, documentId: created.value.id }))?.shownFindings)
    .toContainEqual({ field: "proportionalDeduction", severity: "error", code: "proportional_deduction_invalid" });
});

it.each([
  { net: "1000.00", vat: "210.00", gross: "1210.00", percentage: 60, selectedNet: "600.00", selectedVat: "126.00", section: "B.3", restNet: "400.00", restVat: "84.00" },
  { net: "0.03", vat: "0.01", gross: "0.04", percentage: 50, selectedNet: "0.02", selectedVat: "0.01", section: "B.3", restNet: "0.01", restVat: "0.00" },
  { net: "19.99", vat: "4.20", gross: "24.19", percentage: 33, selectedNet: "6.60", selectedVat: "1.39", section: "B.3", restNet: "13.39", restVat: "2.81" },
  { net: "8264.46", vat: "1735.54", gross: "10000.00", percentage: 50, selectedNet: "4132.23", selectedVat: "867.77", section: "B.3", restNet: "4132.23", restVat: "867.77" },
  { net: "8264.47", vat: "1735.54", gross: "10000.01", percentage: 50, selectedNet: "4132.24", selectedVat: "867.77", section: "B.2", restNet: "4132.23", restVat: "867.77" },
])("exact reduction and full gross classification survive real approval ($gross, $percentage%)", async example => {
  const company = await administratorWithCompany();
  const payload = { ...source, rateBreakdown: [{ rate: 21, netAmount: example.net, vatAmount: example.vat }],
    totals: { netAmount: example.net, vatAmount: example.vat, grossAmount: example.gross } };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  expect(await saveAndApproveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, basedOnVersion: 1,
    requestId: crypto.randomUUID(), payload: { ...payload, proportionalDeduction: { ...ratio, percentage: example.percentage } } }, undefined, registry)).toMatchObject({ ok: true });
  expect((await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" })).ok).toBe(true);
  const report = (await getVatReport(company.client, company.companyId, "2026-10"))!;
  expect(report.result.controlStatement).toMatchObject([{ section: example.section, rateBreakdown: [{ netAmount: example.selectedNet, vatAmount: example.selectedVat }] }]);
  const { proportionalUnclaimedPortion } = await import("@/application/proportional-deduction");
  expect(proportionalUnclaimedPortion(report.documents[0].payload!)).toMatchObject({ netAmount: example.restNet, vatAmount: example.restVat });
});

it("one actual-use coefficient reduces both rates independently and rounds VAT Return lines after summing Documents", async () => {
  const company = await administratorWithCompany();
  const payload = { ...source, rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "210.00" }, { rate: 12, netAmount: "500.00", vatAmount: "60.00" }],
    totals: { netAmount: "1500.00", vatAmount: "270.00", grossAmount: "1770.00" } };
  for (const number of ["MIXED-1", "MIXED-2"]) {
    const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: { ...payload, documentNumber: number } }, undefined, registry);
    if (!created.ok) throw new Error(created.error);
    expect(await saveAndApproveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, basedOnVersion: 1,
      requestId: crypto.randomUUID(), payload: { ...payload, documentNumber: number, proportionalDeduction: { ...ratio, percentage: 60 } } }, undefined, registry)).toMatchObject({ ok: true });
  }
  expect((await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" })).ok).toBe(true);
  const report = (await getVatReport(company.client, company.companyId, "2026-10"))!;
  expect(report.result.vatReturn.filter(line => line.documentIds.length)).toMatchObject([
    { line: "40", netAmount: "1200.00", vatAmount: "252.00" }, { line: "41", netAmount: "600.00", vatAmount: "72.00" },
  ]);
  expect(report.result.controlStatement).toMatchObject([{ section: "B.3", rateBreakdown: [{ rate: 21, netAmount: "1200.00", vatAmount: "252.00" }, { rate: 12, netAmount: "600.00", vatAmount: "72.00" }] }]);
  const xml = await createEpoXml(report.result, "dphdp3", details);
  expect(xml.ok && xml.value).toContain('pln23="1200" odp_tuz23_nar="252" pln5="600" odp_tuz5_nar="72"');
});

it("AI cannot author a proportional decision, including malformed metadata, or introduce its legal findings", async () => {
  const { uploadSourceFile } = await import("@/application/source-files");
  const { listDocuments } = await import("@/application/documents");
  const { assignAiConfigurationFixture } = await import("./support/fixtures");
  const { setOctoberImportFixture } = await import("./support/claim-eligibility");
  const { fixtureFile } = await import("./support/files");
  const { fakeAiProvider } = await import("@/ai/fake");
  const { testWorker } = await import("./support/worker");
  const company = await administratorWithCompany();
  const worker = testWorker(fakeAiProvider({ extract: () => ({ ...source, proportionalDeduction: { ...ratio, percentage: 60.5 } }) }));
  await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const uploaded = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportFixture(uploaded.value.id);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(company.client, company.companyId, uploaded.value.id);
  const [version] = await listExtractionVersions(company.client, company.companyId, document.id);
  expect(version.payload.proportionalDeduction).toBeUndefined();
  expect(version.findings.some(finding => finding.code === "proportional_deduction_invalid")).toBe(false);
});

it("scope, original-total discrepancies and Partial Claim cannot be hidden by a proportional choice", async () => {
  const { correctDocument } = await import("@/application/documents");
  const { getDocumentReview } = await import("@/application/document-review");
  const { proportionalUnclaimedPortion } = await import("@/application/proportional-deduction");
  const company = await administratorWithCompany();
  for (const unsupported of [
    { direction: "outgoing" as const }, { documentType: "credit_note" as const }, { documentType: "debit_note" as const },
    { documentType: "other" as const }, { proposedVatRegime: "domestic_reverse_charge" as const },
    { currency: "EUR" }, { partialClaim: { confirmed: true, rateBreakdown: source.rateBreakdown } },
    { totals: { ...source.totals, netAmount: "12001.00" } },
  ]) {
    const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: source }, undefined, registry);
    if (!created.ok) throw new Error(created.error);
    expect((await company.client.rpc("correct_document", { target_document_id: created.value.id, based_on_version: 1,
      payload: { ...source, ...unsupported, proportionalDeduction: ratio }, findings: [] })).error).toBeNull();
    expect((await company.client.rpc("approve_document", { target_document_id: created.value.id, reviewed_version: 2 })).error).not.toBeNull();
  }
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: source }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const payload = { ...source, totals: { ...source.totals, grossAmount: "14521.00" }, proportionalDeduction: ratio };
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await correctDocument(company.client, { ...input, basedOnVersion: 1, payload }, undefined, registry)).toMatchObject({ ok: true });
  expect((await getDocumentReview(company.client, input))?.shownFindings).toContainEqual(expect.objectContaining({ code: "total_gross_amount_mismatch", severity: "warning" }));
  expect(proportionalUnclaimedPortion((await listExtractionVersions(company.client, input.companyId, input.documentId)).at(-1)!.payload)).toBeNull();
});

it("ratio decisions retain tenant authority, immutable history, audit attribution, stale-write and Period Lock guards", async () => {
  const { companyMember } = await import("./support/fixtures");
  const { getDocument, correctDocument, returnDocumentToReview } = await import("@/application/documents");
  const { listAuditEvents } = await import("@/application/audit");
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const foreign = await administratorWithCompany();
  const created = await createConfirmedManualDocument(user.client, { companyId: company.companyId, payload: source }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await getDocument(foreign.client, input.companyId, input.documentId)).toBeNull();
  expect((await foreign.client.from("extraction_version").select("id,payload").eq("document_id", input.documentId)).data).toEqual([]);
  expect((await foreign.client.rpc("correct_document", { target_document_id: input.documentId, based_on_version: 1, payload: { ...source, proportionalDeduction: ratio }, findings: [] })).error)
    .toMatchObject({ code: "42501" });
  const results = await Promise.all([50, 60].map(percentage => correctDocument(user.client, { ...input, basedOnVersion: 1, payload: { ...source, proportionalDeduction: { ...ratio, percentage } } }, undefined, registry)));
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => !result.ok)).toMatchObject([{ ok: false, error: "stale_version" }]);
  const history = await listExtractionVersions(user.client, input.companyId, input.documentId);
  expect(history).toHaveLength(2);
  expect(history[0].payload.proportionalDeduction).toBeUndefined();
  const audit = (await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "document.proportional_deduction_changed");
  expect(audit).toHaveLength(1);
  expect(history[1].author).toEqual({ kind: "user", userId: audit[0].actorUserId });
  expect(await saveAndApproveDocument(user.client, { ...input, basedOnVersion: 2, requestId: crypto.randomUUID(), payload: history[1].payload }, undefined, registry)).toMatchObject({ ok: true });
  expect((await generateVatReport(user.client, { companyId: input.companyId, period: "2026-10" })).ok).toBe(true);
  const saved = await getVatReport(user.client, input.companyId, "2026-10");
  expect(await finalizeVatReport(company.client, { companyId: input.companyId, period: "2026-10", confirmed: true })).toMatchObject({ ok: true });
  expect(await returnDocumentToReview(user.client, input)).toEqual({ ok: false, error: "period_locked" });
  expect((await user.client.rpc("correct_document", { target_document_id: input.documentId, based_on_version: 2, payload: { ...source, proportionalDeduction: null }, findings: [] })).error).not.toBeNull();
  expect(await getVatReport(user.client, input.companyId, "2026-10")).toEqual(saved);
  expect((await listExtractionVersions(user.client, input.companyId, input.documentId)).slice(0, 2)).toEqual(history);
});

it("December reporting and next-year preparation remain distinct from the general filing deadline and archived artifacts", async () => {
  const { inject } = await import("vitest");
  const { withClaimDate } = await import("./support/claim-clock");
  const { createManualDocument, approveDocument } = await import("@/application/documents");
  const { exportVatReport } = await import("@/application/epo-export");
  await withClaimDate(inject("databaseUrl"), "2027-01-10", async clock => {
    const company = await administratorWithCompany();
    const payload = { ...source, taxPointDate: "2026-12-10", issueDate: "2026-12-10", proportionalDeduction: ratio,
      claimEligibility: { period: "2026-12", origin: "user" as const, confirmed: true } };
    const created = await createManualDocument(company.client, { companyId: company.companyId, payload }, undefined, registry);
    if (!created.ok) throw new Error(created.error);
    const input = { companyId: company.companyId, documentId: created.value.id, version: 1 };
    expect(await approveDocument(company.client, input)).toMatchObject({ ok: true });
    expect((await generateVatReport(company.client, { companyId: input.companyId, period: "2026-12" })).ok).toBe(true);
    const saved = await getVatReport(company.client, input.companyId, "2026-12");
    const exported = await exportVatReport(company.client, { companyId: input.companyId, period: "2026-12", format: "dphkh1",
      details: Object.fromEntries(Object.entries(details).filter(([, value]) => typeof value === "string")) as Record<string, string> });
    if (!exported.ok) throw new Error(exported.error);
    await clock.setDate("2029-01-03");
    expect(await generateVatReport(company.client, { companyId: input.companyId, period: "2026-12" })).toEqual({ ok: false, error: "claim_eligibility_unresolved" });
    expect(await finalizeVatReport(company.client, { companyId: input.companyId, period: "2026-12", confirmed: true })).toEqual({ ok: false, error: "readiness_blocked" });
    expect(await exportVatReport(company.client, { companyId: input.companyId, period: "2026-12", format: "dphkh1",
      details: Object.fromEntries(Object.entries(details).filter(([, value]) => typeof value === "string")) as Record<string, string> }))
      .toEqual({ ok: false, error: "claim_eligibility_unresolved" });
    expect((await company.client.rpc("save_vat_report", { target_company_id: input.companyId, target_period: "2026-12", expected_documents: [], computed_result: {} })).error)
      .toMatchObject({ code: "P0001", hint: "claim_eligibility_unresolved" });
    expect((await company.client.rpc("finalize_vat_report", { target_company_id: input.companyId, target_period: "2026-12", finalization_confirmed: true })).error)
      .toMatchObject({ code: "P0001", hint: "readiness_blocked" });
    expect((await readVatReportArtifact(company.client, { companyId: input.companyId, artifactId: exported.value.artifactId }))?.bytes).toEqual(exported.value.bytes);
    expect(await getVatReport(company.client, input.companyId, "2026-12")).toEqual(saved);
  });
});

it("assignment cannot defer a proportional decision whose Earliest Claim Period has not been confirmed", async () => {
  const { createManualDocument } = await import("@/application/documents");
  const company = await administratorWithCompany();
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: { ...source, proportionalDeduction: ratio } }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  expect((await company.client.rpc("update_document_reporting", { target_document_id: created.value.id, new_claimed_reporting_period: "2026-11" })).error)
    .toMatchObject({ code: "P0001", hint: "claim_eligibility_required" });
});


it("Return XML rounds summed proportional amounts once while Control Statement retains exact cents", async () => {
  const company = await administratorWithCompany();
  const payload = { ...source, rateBreakdown: [{ rate: 21, netAmount: "19.99", vatAmount: "4.20" }],
    totals: { netAmount: "19.99", vatAmount: "4.20", grossAmount: "24.19" } };
  for (const number of ["SMALL-1", "SMALL-2"]) {
    const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: { ...payload, documentNumber: number } }, undefined, registry);
    if (!created.ok) throw new Error(created.error);
    expect(await saveAndApproveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, basedOnVersion: 1,
      requestId: crypto.randomUUID(), payload: { ...payload, documentNumber: number, proportionalDeduction: { ...ratio, percentage: 33 } } }, undefined, registry)).toMatchObject({ ok: true });
  }
  expect((await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" })).ok).toBe(true);
  const report = (await getVatReport(company.client, company.companyId, "2026-10"))!;
  expect(report.result.vatReturn.find(line => line.line === "40")).toMatchObject({ netAmount: "13.20", vatAmount: "2.78" });
  const xml = await createEpoXml(report.result, "dphdp3", details);
  expect(xml.ok && xml.value).toContain('pln23="13" odp_tuz23_nar="3"');
  const kh = await createEpoXml(report.result, "dphkh1", details);
  expect(kh.ok && kh.value).toContain('zakl_dane1="13.20" dan1="2.78"');
});
