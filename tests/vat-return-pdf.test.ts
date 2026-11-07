import { createConfirmedManualDocument } from "./support/claim-eligibility";
import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  createVatReturnPdf,
  exportVatReturnPdf,
  exportVatReturnThumbnail,
} from "@/application/vat-return-pdf";
import { createCompany, updateCompanyIdentity } from "@/application/companies";
import { getVatReportExportHeader } from "@/application/epo-export-context";
import { provisionedUser } from "./support/clients";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { approveDocument } from "@/application/documents";
import { listVatReportArtifacts, exportVatReport } from "@/application/epo-export";
import { getCompanyFilingDefaults, saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { vatReturnPreviewData } from "@/application/vat-return-preview";
import type { ComputedVatReport } from "@/application/vat-rules";
import { finalizeVatReport, getPeriodLock, generateVatReport } from "@/application/vat-reports";
import {
  administratorWithCompany,
  companyMember,
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
  const task = getDocument({ data: Uint8Array.from(bytes) });
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

async function fieldText(bytes: Uint8Array, pageNumber: number, cell: readonly [number, number, number, number]) {
  const task = getDocument({ data: Uint8Array.from(bytes) });
  try {
    const page = await (await task.promise).getPage(pageNumber);
    const [left, top, right, bottom] = cell;
    return (await page.getTextContent()).items.flatMap(item => "str" in item && item.transform[4] >= left && item.transform[4] + item.width <= right + .5 && page.view[3] - item.transform[5] >= top && page.view[3] - item.transform[5] <= bottom ? [item.str] : []).join("").trim();
  } finally { await task.destroy(); }
}

it("renders the green Czech two-page form with rounded values in the statutory amount cells", async () => {
  const task = getDocument({ data: await createVatReturnPdf(vatReturnPreviewData(report)) });
  try {
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(2);
    const first = await (await pdf.getPage(1)).getTextContent();
    const firstText = first.items.flatMap(item => "str" in item ? [item.str] : []).join(" ");
    expect(firstText).toContain("Příliš žluťoučký kůň s.r.o.");
    expect(firstText).toContain("P Ř I Z N Á N Í");
    expect(firstText).not.toContain("Vytištěno");
    const amounts = await (await pdf.getPage(2)).getTextContent();
    const inCell = (left: number, top: number, right: number, bottom: number) => amounts.items.flatMap(item =>
      "str" in item && item.transform[4] >= left && item.transform[4] + item.width <= right + .5 && 842 - item.transform[5] >= top && 842 - item.transform[5] <= bottom ? [item.str] : []).join("").trim();
    for (const [top, base, vat] of [
      [59.64,"100","10"], [73.81,"200","20"], [87.98,"300","30"], [102.16,"400","40"],
      [116.33,"500","50"], [130.50,"600","60"], [187.20,"700","70"], [201.37,"800","80"],
    ] as const) {
      expect(inCell(283, top, 418, top + 14.17)).toBe(base);
      expect(inCell(418, top, 552, top + 14.17)).toBe(vat);
    }
    for (const [top, base, vat] of [[479.17,"1000","100"], [493.34,"1100","110"], [521.68,"1200","120"], [535.86,"1300","130"]] as const) {
      expect(inCell(283, top, 378.4, top + 14.17)).toBe(base);
      expect(inCell(378.3, top, 464.9, top + 14.17)).toBe(vat);
      expect(inCell(465, top, 552, top + 14.17)).toBe("");
    }
    expect(inCell(418,345.94,552,360.11)).toBe("900");
    expect(inCell(378, 564, 465, 579)).toBe("460");
    expect(inCell(418, 739, 552, 755)).toBe("360");
    expect(inCell(418, 754, 552, 769)).toBe("460");
    expect(inCell(418, 768.3, 552, 782.47)).toBe("");
    expect(inCell(418, 782, 552, 797)).toBe("100");
  } finally { await task.destroy(); }
});

it("a Company User downloads the saved VAT Return snapshot as a PDF", async () => {
  const company = await administratorWithCompany();
  const member = await companyMember(company);
  const input = { companyId: company.companyId, period: "2026-10" };
  const approved = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION });
  if (!approved.ok) throw new Error(approved.error);
  expect(await approveDocument(company.client, { companyId: company.companyId, documentId: approved.value.id, version: 1 })).toEqual({ ok: true, value: null });
  await generateVatReport(company.client, input);
  const later = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: { ...SAMPLE_EXTRACTION, documentNumber: "AFTER-SNAPSHOT", rateBreakdown: [{ rate: 21, netAmount: "9000.00", vatAmount: "1890.00" }], totals: { netAmount: "9000.00", vatAmount: "1890.00", grossAmount: "10890.00" } } });
  if (!later.ok) throw new Error(later.error);
  expect(await approveDocument(company.client, { companyId: company.companyId, documentId: later.value.id, version: 1 })).toEqual({ ok: true, value: null });
  const result = await exportVatReturnPdf(member.client, input);

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.fileName).toBe("DPHDP3-2026-10.pdf");
  expect(result.value.mediaType).toBe("application/pdf");
  expect(new TextDecoder().decode(result.value.bytes.slice(0, 5))).toBe("%PDF-");
  expect(await pdfText(result.value.bytes)).toContain("Novák s.r.o.");
  expect(await fieldText(result.value.bytes, 2, [283.46, 479.17, 378.32, 493.34])).toBe("1000");
  expect(await fieldText(result.value.bytes, 2, [378.32, 479.17, 464.82, 493.34])).toBe("210");
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
  for (const literal of ["one-off@example.test", "Středočeský kraj", "Benešově", "622000", "Žaneta", "Říční"]) expect(text).toContain(literal);
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
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: {
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
  const top = example.rate === 21 ? 479.17 : 493.34;
  expect(await fieldText(pdf.value.bytes, 2, [283.46, top, 378.32, top + 14.17])).toBe(example.expectedNet);
  expect(await fieldText(pdf.value.bytes, 2, [378.32, top, 464.82, top + 14.17])).toBe(example.expectedVat);
  expect(await fieldText(pdf.value.bytes, 2, [378.32, 564.20, 464.82, 578.38])).toBe(example.expectedVat);
  expect(await fieldText(pdf.value.bytes, 2, [418.01, 768.30, 551.24, 782.47])).toBe(example.payable === "0" ? "" : example.payable);
  expect(await fieldText(pdf.value.bytes, 2, [418.01, 782.47, 551.24, 796.64])).toBe(example.excess === "0" ? "" : example.excess);
  expect(xml.value.xml).toContain(example.xmlLine);
  expect(xml.value.xml).toContain(example.xmlTotal);
});


it("uses saved natural-person identity and resolved EPO address for VAT Return PDF, header and XML", async () => {
  const format = "dphdp3" as const;
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
  const pdf = await exportVatReturnPdf(user.client, input);
  const xml = await exportVatReport(user.client, { ...input, format });
  if (!header.ok || !pdf.ok || !xml.ok) throw new Error("Export refused");
  expect(header.value.company).toMatchObject({ firstName: "Žaneta", lastName: "Říční" });
  expect(header.value.details.address).toMatchObject({ streetName: "Dlouhá ulice", orientationNumber: "3A" });
  const text = await pdfText(pdf.value.bytes);
  expect(text).toContain("Žaneta");
  expect(text).toContain("Říční");
  expect(text).toContain("Dlouhá ulice");
  expect(text).toContain("12/3A");
  expect(text).not.toContain("Dlouhá registrovaná");
  expect(text).not.toContain("Nová Identita");
  expect(xml.value.xml).toContain('jmeno="Žaneta" prijmeni="Říční" ulice="Dlouhá ulice"');
});


it("allows an incomplete VAT Return PDF/header on a locked report while XML validation, access and history remain unchanged", async () => {
  const format = "dphdp3" as const;
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
  const pdf = await exportVatReturnPdf(company.client, input);
  if (!header.ok || !pdf.ok) throw new Error("Preview refused");
  expect(header.value.details).toMatchObject({ taxOffice: "", territorialOffice: "", economicActivity: "", personType: "P", signatoryFirstName: "Jana", signatoryLastName: "", signatoryCapacity: "", email: "known@example.test", phone: "" });
  const text = await pdfText(pdf.value.bytes);
  expect(text).toContain("known@example.test");
  expect(await fieldText(pdf.value.bytes, 2, [283.46, 59.64, 418.01, 73.81])).toBe("0");
  expect(await fieldText(pdf.value.bytes, 2, [283.46, 87.98, 418.01, 102.16])).toBe("");
  expect(await fieldText(pdf.value.bytes, 2, [418.01, 768.30, 551.24, 782.47])).toBe("0");
  expect(await fieldText(pdf.value.bytes, 2, [418.01, 782.47, 551.24, 796.64])).toBe("");
  expect((await fieldText(pdf.value.bytes, 1, [49.9, 727, 162.8, 743.5])).replace(/\s/g, "")).toBe("04112026");
  expect(await fieldText(pdf.value.bytes, 1, [42.8, 51.4, 269, 67.9])).toBe("");
  expect(await exportVatReport(company.client, { ...input, format })).toEqual({ ok: false, error: "invalid_export_details" });
  expect(await listVatReportArtifacts(company.client, input)).toEqual([]);
  expect(await getPeriodLock(company.client, input.companyId, input.period)).toEqual(lock);
  expect(await getVatReportExportHeader(other.client, input)).toEqual({ ok: false, error: "report_not_found" });
  expect(await exportVatReturnPdf(other.client, input)).toEqual({ ok: false, error: "report_not_found" });
});

it("keeps a complete long contact email inside the downloaded VAT Return form email cell", async () => {
  const format = "dphdp3" as const;
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
  const pdf = await exportVatReturnPdf(company.client, input);
  if (!pdf.ok) throw new Error(pdf.error);
  const task = getDocument({ data: pdf.value.bytes });
  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    const fields = content.items.flatMap(item => "str" in item ? [item] : []).filter(item => item.transform[4] >= 42.4 && item.transform[4] < 325.9 && 842 - item.transform[5] >= 496.4 && 842 - item.transform[5] <= 512.9);
    expect(fields.map(item => item.str).join("").replace(/\s/g, "")).toBe(email);
    for (const field of fields.filter(field => field.str.trim())) {
      expect(field.transform[4] + field.width).toBeLessThanOrEqual(325.9);
      expect(field.transform[5] + field.height).toBeLessThanOrEqual(842 - 496.4);
    }
  } finally {
    await task.destroy();
  }
});

it("prepares a private one-page header preview, permits missing XML details and denies foreign Company access", async () => {
  const company = await administratorWithCompany();
  const other = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-10", details: { preparedOn: "2026-11-04", email: "thumbnail@example.test", taxOffice: "" } };
  expect(await exportVatReturnThumbnail(company.client, input)).toEqual({ ok: false, error: "report_not_found" });
  await generateVatReport(company.client, input);
  const result = await exportVatReturnThumbnail(company.client, input);
  if (!result.ok) throw new Error(result.error);
  const task = getDocument({ data: result.value.bytes });
  try {
    const document = await task.promise;
    expect(document.numPages).toBe(1);
    const text = (await (await document.getPage(1)).getTextContent()).items.flatMap(item => "str" in item ? [item.str] : []).join(" ");
    expect(text).toContain("thumbnail@example.test");
    expect(text).toContain("Novák s.r.o.");
    expect(text).not.toContain("Vytištěno");
  } finally { await task.destroy(); }
  expect(await exportVatReport(company.client, { ...input, format: "dphdp3" })).toEqual({ ok: false, error: "invalid_export_details" });
  expect(await exportVatReturnThumbnail(other.client, input)).toEqual({ ok: false, error: "report_not_found" });
});

it("keeps a long valid Company name and quarterly header readable in their printed fields", async () => {
  const name = `${"Žluťoučká obchodní společnost ".repeat(8)}s.r.o.`;
  const bytes = await createVatReturnPdf(vatReturnPreviewData({ ...report, period: "2026-Q4", company: { ...report.company, name } }));
  const first = await fieldText(bytes, 1, [42.8, 349, 566.7, 365.5]);
  const continuation = await fieldText(bytes, 1, [42.7, 368.9, 396.6, 385.4]);
  expect(continuation).not.toBe("");
  expect(await fieldText(bytes, 1, [253.6, 261.1, 309.8, 277.6])).toBe("");
  expect(await fieldText(bytes, 1, [361.1, 261.1, 417.3, 277.6])).toBe("4");
  expect(await fieldText(bytes, 1, [447, 261.1, 503.2, 277.6])).toBe("2026");
  expect((first + continuation).replace(/\s/g, "")).toBe(name.replace(/\s/g, ""));
});
