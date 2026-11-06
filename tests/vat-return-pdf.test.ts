import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  createVatReturnPdf,
  exportVatReturnPdf,
} from "@/application/vat-return-pdf";
import { createCompany, updateCompanyIdentity } from "@/application/companies";
import { exportControlStatementPdf } from "@/application/control-statement-pdf";
import { getVatReportExportHeader } from "@/application/epo-export-context";
import { provisionedUser } from "./support/clients";
import czechMessages from "../messages/cs.json";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { approveDocument, createManualDocument } from "@/application/documents";
import { listVatReportArtifacts, exportVatReport } from "@/application/epo-export";
import { getCompanyFilingDefaults, saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { vatReturnPreviewData } from "@/application/vat-return-preview";
import type { ComputedVatReport } from "@/application/vat-rules";
import { finalizeVatReport, getPeriodLock, generateVatReport } from "@/application/vat-reports";
import {
  administratorWithCompany,
  companyMember,
  companyWithManyReportDocuments,
  companyDetails,
} from "./support/fixtures";

const vatReturnLines: ComputedVatReport["vatReturn"] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "10",
  "11",
  "25",
  "40",
  "41",
  "43",
  "44",
].map((line, index) => ({
  line: line as ComputedVatReport["vatReturn"][number]["line"],
  netAmount: `${index + 1}00.00`,
  vatAmount: `${index + 1}0.00`,
  documentIds: [`document-${index + 1}`],
}));

const report: ComputedVatReport = {
  company: {
    name: "Příliš žluťoučký kůň s.r.o.",
    firstName: null,
    lastName: null,
    ico: "12345678",
    vatId: "CZ12345678",
    streetName: "Říční",
    houseNumber: "1",
    orientationNumber: null,
    city: "Brno",
    postalCode: "602 00",
    personType: "legal",
  },
  period: "2026-10",
  vatReturn: vatReturnLines,
  controlStatement: [],
  totals: {
    outputVat: "1234.00",
    inputVat: "432.00",
    payable: "802.00",
    excessDeduction: "0.00",
  },
  totalDocumentIds: {
    outputVat: ["document-1"],
    inputVat: ["document-10"],
    payable: ["document-1", "document-10"],
    excessDeduction: [],
  },
  excludedDocuments: [],
};

async function pdfText(bytes: Uint8Array) {
  const task = getDocument({ data: bytes });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const content = await (await pdf.getPage(pageNumber)).getTextContent();
    pages.push(
      content.items
        .flatMap((item) => ("str" in item ? [item.str] : []))
        .join(" "),
    );
  }
  await task.destroy();
  return pages.join("\n");
}

it("renders the Company header, every HTML preview line and totals in the VAT Return PDF", async () => {
  const preview = vatReturnPreviewData(report);

  expect(preview).toEqual({
    company: report.company,
    period: report.period,
    lines: report.vatReturn,
    totals: report.totals,
  });

  const text = await pdfText(await createVatReturnPdf(preview));
  expect(text).toContain("Příliš žluťoučký kůň s.r.o.");
  expect(text).toContain("CZ12345678");
  expect(text).toContain("12345678");
  expect(text).toContain("Říční 1");
  expect(text).toContain("602 00 Brno");
  expect(text).toContain("2026-10");
  for (const line of report.vatReturn) {
    expect(text).toContain(`Line ${line.line}`);
    expect(text).toContain(line.netAmount);
    expect(text).toContain(line.vatAmount);
  }
  for (const amount of Object.values(report.totals)) {
    expect(text).toContain(amount);
  }
});

it("a Company User downloads the saved VAT Return snapshot as a PDF", async () => {
  const company = await companyWithManyReportDocuments(1);
  const member = await companyMember(company);
  const input = { companyId: company.companyId, period: "2026-10" };
  await generateVatReport(company.client, input);

  const result = await exportVatReturnPdf(member.client, input);

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.fileName).toBe("DPHDP3-2026-10.pdf");
  expect(result.value.mediaType).toBe("application/pdf");
  expect(new TextDecoder().decode(result.value.bytes.slice(0, 5))).toBe("%PDF-");
  expect(await pdfText(result.value.bytes)).toContain("Novák s.r.o.");
});

it("does not expose another Organization's VAT Return PDF", async () => {
  const owner = await administratorWithCompany();
  const other = await administratorWithCompany();
  const input = { companyId: owner.companyId, period: "2026-10" };
  await generateVatReport(owner.client, input);

  expect(await exportVatReturnPdf(other.client, input)).toEqual({
    ok: false,
    error: "report_not_found",
  });
});


it("uses the current export header in PDF and XML without changing Company defaults", async () => {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-10", details: {
    preparedOn: "2026-11-04", email: "one-off@example.test", phone: "",
    taxOffice: "452", territorialOffice: "2103", economicActivity: "622000",
    signatoryFirstName: "Žaneta", signatoryLastName: "Říční", signatoryCapacity: "jednatelka",
  } };
  await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId, taxOffice: "451", territorialOffice: "2003", economicActivity: "621000",
    signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
    email: "default@example.test", phone: "+420123456789", epoAddressOverride: null,
  });
  await generateVatReport(company.client, input);
  const pdf = await exportVatReturnPdf(company.client, input);
  const xml = await exportVatReport(company.client, { ...input, format: "dphdp3" });
  if (!pdf.ok || !xml.ok) throw new Error("Export refused");
  const text = await pdfText(pdf.value.bytes);
  for (const literal of ["04.11.2026", "one-off@example.test", "452", "2103", "622000", "Žaneta", "Říční"]) expect(text).toContain(literal);
  expect(text).not.toContain("default@example.test");
  expect(text).not.toContain("+420123456789");
  expect(xml.value.xml).toContain('d_poddp="04.11.2026"');
  expect(xml.value.xml).toContain('email="one-off@example.test"');
  expect(await getCompanyFilingDefaults(company.client, company.companyId)).toMatchObject({ email: "default@example.test", phone: "+420123456789" });
});


it.each([
  { rate: 21, net: "1002.50", vat: "210.53", gross: "1213.03", expectedLine: "Line 40", expectedNet: "1003", expectedVat: "211", payable: "0", excess: "211", xmlLine: 'pln23="1003" odp_tuz23_nar="211"', xmlTotal: 'odp_zocelk="211" dano_no="211"' },
  { rate: 21, net: "-1002.50", vat: "-210.53", gross: "-1213.03", expectedLine: "Line 40", expectedNet: "-1003", expectedVat: "-211", payable: "211", excess: "0", xmlLine: 'pln23="-1003" odp_tuz23_nar="-211"', xmlTotal: 'odp_zocelk="-211" dano_da="211"' },
  { rate: 12, net: "1004.17", vat: "120.50", gross: "1124.67", expectedLine: "Line 41", expectedNet: "1004", expectedVat: "121", payable: "0", excess: "121", xmlLine: 'pln5="1004" odp_tuz5_nar="121"', xmlTotal: 'odp_zocelk="121" dano_no="121"' },
])("rounds VAT Return $net/$vat and derives PDF totals from the same whole-CZK values as XML", async example => {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-10", details: {
    preparedOn: "2026-11-04", taxOffice: "451", economicActivity: "621000",
    signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
  } };
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: {
    ...SAMPLE_EXTRACTION, documentType: example.net.startsWith("-") ? "credit_note" : "invoice",
    rateBreakdown: [{ rate: example.rate, netAmount: example.net, vatAmount: example.vat }],
    totals: { netAmount: example.net, vatAmount: example.vat, grossAmount: example.gross },
  } });
  if (!created.ok) throw new Error(created.error);
  expect(await approveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, version: 1 })).toEqual({ ok: true, value: null });
  await generateVatReport(company.client, input);
  const pdf = await exportVatReturnPdf(company.client, input);
  const xml = await exportVatReport(company.client, { ...input, format: "dphdp3" });
  if (!pdf.ok || !xml.ok) throw new Error("Export refused");
  const text = await pdfText(pdf.value.bytes);
  expect(text).toMatch(new RegExp(`${example.expectedLine}\\s+${example.expectedNet}\\s+${example.expectedVat}`));
  expect(text).toMatch(new RegExp(`Input VAT deduction\\s+${example.expectedVat}`));
  expect(text).toMatch(new RegExp(`VAT payable\\s+${example.payable}`));
  expect(text).toMatch(new RegExp(`Excess deduction\\s+${example.excess}`));
  expect(xml.value.xml).toContain(example.xmlLine);
  expect(xml.value.xml).toContain(example.xmlTotal);
});


it.each(["dphdp3", "dphkh1"] as const)("uses saved natural-person identity and resolved EPO address for %s PDF, header and XML", async format => {
  const user = await provisionedUser();
  const identity = companyDetails({ personType: "natural", firstName: "Žaneta", lastName: "Říční", streetName: "Dlouhá registrovaná ulice překračující limit EPO" });
  const company = await createCompany(user.client, { ...identity, organizationId: user.organizationId });
  if (!company.ok) throw new Error(company.error);
  const input = { companyId: company.value.id, period: "2026-10", details: { preparedOn: "2026-11-04" } };
  expect(await saveCompanyFilingDefaults(user.client, {
    companyId: input.companyId, taxOffice: "451", economicActivity: "621000", email: "", phone: "",
    signatoryFirstName: "", signatoryLastName: "", signatoryCapacity: "",
    epoAddressOverride: { streetName: "Dlouhá ulice", houseNumber: "12", orientationNumber: "3A", city: "Praha", postalCode: "120 00" }, epoAddressConfirmed: true,
  })).toEqual({ ok: true, value: null });
  await generateVatReport(user.client, input);
  expect(await updateCompanyIdentity(user.client, { ...identity, companyId: input.companyId, firstName: "Nová", lastName: "Identita" })).toEqual({ ok: true, value: null });
  const header = await getVatReportExportHeader(user.client, input);
  const pdf = format === "dphdp3" ? await exportVatReturnPdf(user.client, input) : await exportControlStatementPdf(user.client, input, czechMessages.vatReports.controlStatementPdf);
  const xml = await exportVatReport(user.client, { ...input, format });
  if (!header.ok || !pdf.ok || !xml.ok) throw new Error("Export refused");
  expect(header.value.company).toMatchObject({ firstName: "Žaneta", lastName: "Říční" });
  expect(header.value.details.address).toMatchObject({ streetName: "Dlouhá ulice", orientationNumber: "3A" });
  const text = await pdfText(pdf.value.bytes);
  expect(text).toContain("Žaneta Říční");
  expect(text).toContain("Dlouhá ulice 12/3A");
  expect(text).not.toContain("Dlouhá registrovaná");
  expect(text).not.toContain("Nová Identita");
  expect(xml.value.xml).toContain('jmeno="Žaneta" prijmeni="Říční" ulice="Dlouhá ulice"');
});


it.each(["dphdp3", "dphkh1"] as const)("allows an incomplete %s PDF/header on a locked report while XML validation, access and history remain unchanged", async format => {
  const company = await administratorWithCompany();
  const other = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-10", details: {
    preparedOn: "2026-11-04", taxOffice: "", email: "known@example.test", phone: "",
    personType: "F", signatoryFirstName: "Jana",
  } };
  await generateVatReport(company.client, input);
  expect(await finalizeVatReport(company.client, { ...input, confirmed: true })).toEqual({ ok: true, value: null });
  const lock = await getPeriodLock(company.client, input.companyId, input.period);
  const header = await getVatReportExportHeader(company.client, input);
  const pdf = format === "dphdp3" ? await exportVatReturnPdf(company.client, input) : await exportControlStatementPdf(company.client, input, czechMessages.vatReports.controlStatementPdf);
  if (!header.ok || !pdf.ok) throw new Error("Preview refused");
  expect(header.value.details).toMatchObject({ taxOffice: "", territorialOffice: "", economicActivity: "", personType: "P", signatoryFirstName: "Jana", signatoryLastName: "", signatoryCapacity: "", email: "known@example.test", phone: "" });
  const text = await pdfText(pdf.value.bytes);
  expect(text).toContain("known@example.test");
  expect(text).toContain("04.11.2026");
  expect(text).toMatch(/Finanční úřad:\s+Územní pracoviště:\s+Ekonomická činnost:/);
  expect(await exportVatReport(company.client, { ...input, format })).toEqual({ ok: false, error: "invalid_export_details" });
  expect(await listVatReportArtifacts(company.client, input)).toEqual([]);
  expect(await getPeriodLock(company.client, input.companyId, input.period)).toEqual(lock);
  expect(await getVatReportExportHeader(other.client, input)).toEqual({ ok: false, error: "report_not_found" });
  expect(format === "dphdp3" ? await exportVatReturnPdf(other.client, input) : await exportControlStatementPdf(other.client, input, czechMessages.vatReports.controlStatementPdf)).toEqual({ ok: false, error: "report_not_found" });
});

it.each(["dphdp3", "dphkh1"] as const)("keeps a complete long contact email inside the downloaded %s PDF and moves following fields", async format => {
  const company = await administratorWithCompany();
  const email = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}`;
  const input = { companyId: company.companyId, period: "2026-10", details: {
    preparedOn: "2026-11-04", taxOffice: "13", territorialOffice: "", economicActivity: "621000",
    email, phone: "+420123456789", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
  } };
  await generateVatReport(company.client, input);
  const xml = await exportVatReport(company.client, { ...input, format });
  expect(xml.ok).toBe(true);
  if (!xml.ok) throw new Error(xml.error);
  expect(xml.value.xml).toContain(`email="${email}"`);
  const pdf = format === "dphdp3" ? await exportVatReturnPdf(company.client, input) : await exportControlStatementPdf(company.client, input, czechMessages.vatReports.controlStatementPdf);
  if (!pdf.ok) throw new Error(pdf.error);
  const task = getDocument({ data: pdf.value.bytes });
  try {
    const document = await task.promise;
    const page = await document.getPage(document.numPages);
    const content = await page.getTextContent();
    const fields = content.items.flatMap(item => "str" in item ? [item] : []);
    expect(fields.map(item => item.str).join("").replace(/\s/g, "")).toContain(email);
    expect(fields.map(item => item.str).join(" ")).toContain("Územní pracoviště: 4000");
    for (const field of fields.filter(item => item.str.trim())) {
      expect(field.transform[4]).toBeGreaterThanOrEqual(42 - 0.5);
      expect(field.transform[4] + field.width).toBeLessThanOrEqual(page.view[2] - 42 + 0.5);
    }
    const emailField = fields.find(item => item.str.startsWith("E-mail:"));
    const phoneField = fields.find(item => item.str.startsWith("Telefon:"));
    expect(emailField).toBeDefined();
    expect(phoneField).toBeDefined();
    expect(phoneField!.transform[5]).toBeLessThan(emailField!.transform[5] - 28);
  } finally {
    await task.destroy();
  }
});
