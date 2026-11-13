import { expect, it } from "vitest";
import * as XLSX from "xlsx";
import { getDocument as readPdf } from "pdfjs-dist/legacy/build/pdf.mjs";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { saveAndApproveDocument, listExtractionVersions, returnDocumentToReview } from "@/application/documents";
import { getDocumentReview } from "@/application/document-review";
import { generateVatReport, getVatReport, finalizeVatReport, unlockReportingPeriod } from "@/application/vat-reports";
import { exportFinalVatReport, readVatReportArtifact } from "@/application/epo-export";
import { exportReportingPeriodWorkbook } from "@/application/reporting-period-excel";
import { createVatReturnPdf } from "@/application/vat-return-pdf";
import { createControlStatementPdf } from "@/application/control-statement-pdf";
import { vatReturnPreviewData } from "@/application/vat-return-preview";
import { prepareControlStatement } from "@/application/epo-values";
import { claimBasis } from "@/application/partial-claim";
import { fakeExchangeRates } from "@/cnb/fake";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany } from "./support/fixtures";
import { createConfirmedManualDocument } from "./support/claim-eligibility";
import { reportingWorkbookCopy } from "./support/reporting-workbook-copy";

const source = { ...SAMPLE_EXTRACTION, currency: "EUR",
  rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "210.00" }],
  totals: { netAmount: "1000.00", vatAmount: "210.00", grossAmount: "1210.00" } };
const ratio = { percentage: 50, confirmed: true, operatingExpenseConfirmed: true, actualUseConfirmed: true, origin: "user" as const };
const registry = fakeVatPayerRegistry();
const details = { taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", preparedOn: "2026-10-27", personType: "P" as const,
  email: "qa@example.test", phone: "", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka" };

async function pdfText(bytes: Uint8Array) {
  const task = readPdf({ data: Uint8Array.from(bytes) });
  try {
    const pdf = await task.promise;
    return (await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) =>
      (await (await pdf.getPage(index + 1)).getTextContent()).items.flatMap(item => "str" in item ? [item.str] : []).join(" ")))).join("\n");
  } finally { await task.destroy(); }
}

it("reduces original EUR before the saved quoted-unit fixing and reconciles real report, XML, PDF and XLSX", async () => {
  const company = await administratorWithCompany();
  const rates = fakeExchangeRates("2434.50", 100);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: source }, rates, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 1, requestId: crypto.randomUUID(),
    payload: { ...source, proportionalDeduction: ratio } }, rates, registry)).toEqual({ ok: true, value: { version: 2 } });
  const versions = await listExtractionVersions(company.client, input.companyId, input.documentId);
  expect(versions[1].payload).toMatchObject({ currency: "EUR", rateBreakdown: source.rateBreakdown, totals: source.totals,
    czkConversion: { rate: "2434.50", unit: 100, totals: { netAmount: "24345.00", vatAmount: "5112.45", grossAmount: "29457.45" } } });
  expect((await getDocumentReview(company.client, input))?.reporting.proportionalDeduction).toMatchObject({ netAmount: "500.00", vatAmount: "105.00",
    unclaimed: { netAmount: "500.00", vatAmount: "105.00" } });
  expect(await generateVatReport(company.client, { companyId: input.companyId, period: "2026-10" })).toMatchObject({ ok: true });
  const report = (await getVatReport(company.client, input.companyId, "2026-10"))!;
  expect(report.result.vatReturn.find(line => line.line === "40")).toMatchObject({ netAmount: "12172.50", vatAmount: "2556.23" });
  expect(report.result.controlStatement).toMatchObject([{ section: "B.2", proportionalDeduction: true,
    rateBreakdown: [{ netAmount: "12172.50", vatAmount: "2556.23" }] }]);
  const workbook = await exportReportingPeriodWorkbook(company.client, { companyId: input.companyId, period: "2026-10" }, reportingWorkbookCopy());
  if (!workbook.ok) throw new Error(workbook.error);
  const book = XLSX.read(workbook.value.bytes, { type: "array" });
  expect(XLSX.utils.sheet_to_json(book.Sheets.Included)).toMatchObject([{ Currency: "EUR", "Net amount": 1000, "VAT amount": 210,
    "Claimed net amount": 500, "Claimed VAT amount": 105, "Unclaimed net amount": 500, "Unclaimed VAT amount": 105 }]);
  expect(await finalizeVatReport(company.client, { companyId: input.companyId, period: "2026-10", confirmed: true })).toMatchObject({ ok: true });
  const artifacts: { id: string; bytes: Uint8Array }[] = [];
  for (const format of ["dphdp3", "dphkh1"]) {
    const exported = await exportFinalVatReport(company.client, { companyId: input.companyId, period: "2026-10", format, details });
    if (!exported.ok) throw new Error(exported.error);
    const artifact = await readVatReportArtifact(company.client, { companyId: input.companyId, artifactId: exported.value.artifactId });
    expect(artifact?.bytes).toEqual(exported.value.bytes);
    artifacts.push({ id: exported.value.artifactId, bytes: exported.value.bytes });
    expect(new TextDecoder().decode(artifact!.bytes)).toMatch(format === "dphkh1"
      ? /pomer="A"[^>]*zakl_dane1="12172.50" dan1="2556.23"/ : /pln23="12173" odp_tuz23_nar="2556"/);
  }
  expect(await pdfText(await createVatReturnPdf(vatReturnPreviewData(report.result)))).toMatch(/12173\s+2556/);
  expect(await pdfText(await createControlStatementPdf({ company: report.result.company, period: report.period, details }, prepareControlStatement(report.result))))
    .toMatch(/12172.50\s+2556.23[\s\S]*A/);
  expect(await returnDocumentToReview(company.client, input)).toEqual({ ok: false, error: "period_locked" });
  expect(await unlockReportingPeriod(company.client, { companyId: input.companyId, period: "2026-10", confirmed: true, reason: "Correct the original foreign amounts" })).toMatchObject({ ok: true });
  expect(await returnDocumentToReview(company.client, input)).toMatchObject({ ok: true });
  const corrected = { ...source, rateBreakdown: [{ rate: 21, netAmount: "2000.00", vatAmount: "420.00" }],
    totals: { netAmount: "2000.00", vatAmount: "420.00", grossAmount: "2420.00" } };
  expect(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 2, requestId: crypto.randomUUID(),
    payload: { ...corrected, proportionalDeduction: { ...ratio, basis: claimBasis(corrected) } } }, fakeExchangeRates("25.00"), registry)).toMatchObject({ ok: true });
  expect((await listExtractionVersions(company.client, input.companyId, input.documentId)).slice(0, 2)).toEqual(versions);
  expect((await getVatReport(company.client, input.companyId, "2026-10"))?.result).toEqual(report.result);
  expect(await generateVatReport(company.client, { companyId: input.companyId, period: "2026-10" })).toMatchObject({ ok: true });
  expect((await getVatReport(company.client, input.companyId, "2026-10"))?.result.controlStatement).toMatchObject([
    { section: "B.2", proportionalDeduction: true, rateBreakdown: [{ netAmount: "25000.00", vatAmount: "5250.00" }] },
  ]);
  for (const artifact of artifacts) {
    expect((await readVatReportArtifact(company.client, { companyId: input.companyId, artifactId: artifact.id }))?.bytes).toEqual(artifact.bytes);
  }
});

it("rejects a stored conversion left behind by a full-amount change instead of silently changing the B.2 threshold", async () => {
  const company = await administratorWithCompany();
  const rates = fakeExchangeRates("2434.50", 100);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: source }, rates, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  const original = (await listExtractionVersions(company.client, input.companyId, input.documentId))[0].payload;
  const candidate = { ...original, proportionalDeduction: ratio, czkConversion: { ...original.czkConversion!,
    totals: { ...original.czkConversion!.totals, grossAmount: "9999.00" } } };
  expect((await company.client.rpc("correct_document", { target_document_id: input.documentId, based_on_version: 1, payload: candidate, findings: [] })).error).toBeNull();
  expect((await company.client.rpc("approve_document", { target_document_id: input.documentId, reviewed_version: 2 })).error)
    .toMatchObject({ code: "P0001" });
  const review = await getDocumentReview(company.client, input);
  expect(review?.reporting.blockingFindings).toContainEqual({ field: "czkConversion", severity: "error", code: "proportional_deduction_conversion_required" });
  expect(review?.reporting.proportionalDeduction).toBeNull();
  expect(review?.reporting.mapping.controlStatementUnknownReason).toBe("currency_conversion_required");
  expect((await listExtractionVersions(company.client, input.companyId, input.documentId))[0].payload).toEqual(original);
});

it("keeps a malformed saved conversion reviewable and explicitly unavailable under the real user's identity", async () => {
  const company = await administratorWithCompany();
  const rates = fakeExchangeRates("24.345");
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: source }, rates, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  const original = (await listExtractionVersions(company.client, input.companyId, input.documentId))[0].payload;
  expect((await company.client.rpc("correct_document", { target_document_id: input.documentId, based_on_version: 1,
    payload: { ...original, proportionalDeduction: ratio, czkConversion: { ...original.czkConversion!, rateBreakdown: null } }, findings: [] })).error).toBeNull();
  expect((await company.client.rpc("approve_document", { target_document_id: input.documentId, reviewed_version: 2 })).error).not.toBeNull();
  const review = await getDocumentReview(company.client, input);
  expect(review?.reporting.blockingFindings).toContainEqual({ field: "czkConversion", severity: "error", code: "proportional_deduction_conversion_required" });
  expect(review?.reporting.proportionalDeduction).toBeNull();
  expect(review?.document.status).toBe("needs_review");
});

it.each([
  { net: "19.99", vat: "4.20", gross: "24.19", fixing: "24.345", percentage: 33, claimedNet: "160.68", claimedVat: "33.84", section: "B.3", originalClaimedNet: 6.6, originalClaimedVat: 1.39, unclaimedNet: 13.39, unclaimedVat: 2.81 },
  { net: "1000.00", vat: "210.00", gross: "1210.00", fixing: "24.345", percentage: 10, claimedNet: "2434.50", claimedVat: "511.25", section: "B.2", originalClaimedNet: 100, originalClaimedVat: 21, unclaimedNet: 900, unclaimedVat: 189 },
  { net: "8264.46", vat: "1735.54", gross: "10000.00", fixing: "1.00", percentage: 50, claimedNet: "4132.23", claimedVat: "867.77", section: "B.3", originalClaimedNet: 4132.23, originalClaimedVat: 867.77, unclaimedNet: 4132.23, unclaimedVat: 867.77 },
  { net: "8264.47", vat: "1735.54", gross: "10000.01", fixing: "1.00", percentage: 50, claimedNet: "4132.24", claimedVat: "867.77", section: "B.2", originalClaimedNet: 4132.24, originalClaimedVat: 867.77, unclaimedNet: 4132.23, unclaimedVat: 867.77 },
])("source-currency rounding and full converted gross determine the actual foreign claim ($gross, $percentage%)", async example => {
  const company = await administratorWithCompany();
  const rates = fakeExchangeRates(example.fixing);
  const payload = { ...source, rateBreakdown: [{ rate: 21, netAmount: example.net, vatAmount: example.vat }],
    totals: { netAmount: example.net, vatAmount: example.vat, grossAmount: example.gross } };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload }, rates, registry);
  if (!created.ok) throw new Error(created.error);
  expect(await saveAndApproveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, basedOnVersion: 1,
    requestId: crypto.randomUUID(), payload: { ...payload, proportionalDeduction: { ...ratio, percentage: example.percentage } } }, rates, registry)).toMatchObject({ ok: true });
  expect(await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" })).toMatchObject({ ok: true });
  const report = (await getVatReport(company.client, company.companyId, "2026-10"))!;
  expect(report.result.controlStatement).toMatchObject([{ section: example.section, rateBreakdown: [{ netAmount: example.claimedNet, vatAmount: example.claimedVat }] }]);
  const workbook = await exportReportingPeriodWorkbook(company.client, { companyId: company.companyId, period: "2026-10" }, reportingWorkbookCopy());
  if (!workbook.ok) throw new Error(workbook.error);
  const book = XLSX.read(workbook.value.bytes, { type: "array" });
  expect(XLSX.utils.sheet_to_json(book.Sheets.Included)).toMatchObject([{ Currency: "EUR", "Claimed net amount": example.originalClaimedNet,
    "Claimed VAT amount": example.originalClaimedVat, "Unclaimed net amount": example.unclaimedNet, "Unclaimed VAT amount": example.unclaimedVat }]);
});

it.each([
  { label: "wrong currency", patch: { originalCurrency: "USD" } },
  { label: "missing fixing", patch: { rate: null } },
  { label: "zero fixing", patch: { rate: "0" } },
  { label: "negative fixing", patch: { rate: "-24.345" } },
  { label: "non-decimal fixing", patch: { rate: "2e1" } },
  { label: "zero quoted unit", patch: { unit: 0 } },
  { label: "fractional quoted unit", patch: { unit: 1.5 } },
  { label: "string quoted unit", patch: { unit: "1" } },
  { label: "unsafe quoted unit", patch: { unit: 9007199254740992 } },
  { label: "future fixing", patch: { rateDate: "2026-11-01" } },
  { label: "invalid fixing date", patch: { rateDate: "2026-02-30" } },
  { label: "unknown source", patch: { source: "other" } },
  { label: "missing totals", patch: { totals: null } },
  { label: "stale rate row", patch: { rateBreakdown: [{ rate: 21, netAmount: "0.00", vatAmount: "5112.45" }] } },
  { label: "duplicate rate row", patch: { rateBreakdown: [{ rate: 21, netAmount: "24345.00", vatAmount: "5112.45" }, { rate: 21, netAmount: "24345.00", vatAmount: "5112.45" }] } },
])("the authenticated database refuses $label without trusting supplied empty findings", async ({ patch }) => {
  const company = await administratorWithCompany();
  const rates = fakeExchangeRates("24.345");
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: source }, rates, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  const original = (await listExtractionVersions(company.client, input.companyId, input.documentId))[0].payload;
  expect((await company.client.rpc("correct_document", { target_document_id: input.documentId, based_on_version: 1,
    payload: { ...original, proportionalDeduction: ratio, czkConversion: { ...original.czkConversion!, ...patch } }, findings: [] })).error).toBeNull();
  expect((await company.client.rpc("approve_document", { target_document_id: input.documentId, reviewed_version: 2 })).error).not.toBeNull();
  const review = await getDocumentReview(company.client, input);
  expect(review?.document.status).toBe("needs_review");
  expect(review?.reporting.proportionalDeduction).toBeNull();
  expect(review?.reporting.blockingFindings).toContainEqual({ field: "czkConversion", severity: "error", code: "proportional_deduction_conversion_required" });
});

it("a missing external fixing leaves the foreign ratio explicitly unavailable and cannot approve a zero contribution", async () => {
  const company = await administratorWithCompany();
  const rates = { async rateFor() { return null; } };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: source }, rates, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 1, requestId: crypto.randomUUID(),
    payload: { ...source, proportionalDeduction: ratio } }, rates, registry)).toMatchObject({ ok: false, error: "document_validation_failed",
    findings: expect.arrayContaining([{ field: "czkConversion", severity: "error", code: "proportional_deduction_conversion_required" }]) });
  expect((await listExtractionVersions(company.client, input.companyId, input.documentId))).toHaveLength(1);
});

it("converts both independently reduced VAT rates without re-estimating VAT from the converted base", async () => {
  const company = await administratorWithCompany();
  const rates = fakeExchangeRates("24.345");
  const payload = { ...source, rateBreakdown: [{ rate: 21, netAmount: "1000.10", vatAmount: "210.02" }, { rate: 12, netAmount: "1000.20", vatAmount: "120.02" }],
    totals: { netAmount: "2000.30", vatAmount: "330.04", grossAmount: "2330.34" } };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload }, rates, registry);
  if (!created.ok) throw new Error(created.error);
  expect(await saveAndApproveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, basedOnVersion: 1, requestId: crypto.randomUUID(),
    payload: { ...payload, proportionalDeduction: { ...ratio, percentage: 33 } } }, rates, registry)).toMatchObject({ ok: true });
  expect(await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" })).toMatchObject({ ok: true });
  const report = (await getVatReport(company.client, company.companyId, "2026-10"))!;
  expect(report.result.vatReturn.filter(line => line.documentIds.length)).toMatchObject([
    { line: "40", netAmount: "8034.58", vatAmount: "1687.35" }, { line: "41", netAmount: "8035.55", vatAmount: "964.31" },
  ]);
  expect(report.result.totals.inputVat).toBe("2651.66");
  const { createEpoXml } = await import("@/application/epo-xml");
  const xml = await createEpoXml(report.result, "dphkh1", details);
  expect(xml.ok && xml.value).toMatch(/pomer="A"[^>]*zakl_dane1="8034.58" dan1="1687.35" zakl_dane2="8035.55" dan2="964.31"/);
});

it("requires the supplier identity from the full converted gross while keeping foreign ratio data tenant-private", async () => {
  const company = await administratorWithCompany();
  const outsider = await administratorWithCompany();
  const rates = fakeExchangeRates("24.345");
  const payload = { ...source, supplier: { ...source.supplier, vatId: null } };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload }, rates, registry);
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 1, requestId: crypto.randomUUID(),
    payload: { ...payload, proportionalDeduction: { ...ratio, percentage: 10 } } }, rates, registry))
    .toMatchObject({ ok: false, error: "counterparty_vat_id_required", findings: expect.arrayContaining([expect.objectContaining({ code: "counterparty_vat_id_required" })]) });
  expect(await getDocumentReview(outsider.client, input)).toBeNull();
  expect((await outsider.client.from("extraction_version").select("payload").eq("document_id", input.documentId)).data).toEqual([]);
  expect((await outsider.client.rpc("correct_document", { target_document_id: input.documentId, based_on_version: 1,
    payload: { ...source, proportionalDeduction: ratio }, findings: [] })).error).toMatchObject({ code: "42501" });
});
