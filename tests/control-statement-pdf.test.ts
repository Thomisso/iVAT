import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { exportControlStatementPdf, exportControlStatementThumbnail } from "@/application/control-statement-pdf";
import { exportVatReport } from "@/application/epo-export";
import { generateVatReport } from "@/application/vat-reports";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { createManualDocument, approveDocument } from "@/application/documents";
import { administratorWithCompany, companyDetails, companyMember, companyWithManyReportDocuments } from "./support/fixtures";
import { createCompany, updateCompanyIdentity } from "@/application/companies";
import { getCompanyFilingDefaults, saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { provisionedUser } from "./support/clients";
import { listCompanyDocuments } from "@/application/documents";
import englishMessages from "../messages/en.json";

const copy = englishMessages.vatReports.controlStatementPdf;
const details = { preparedOn: "2026-11-03", taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka", email: "one-off@example.test" };

async function pages(bytes: Uint8Array) {
  const task = getDocument({ data: Uint8Array.from(bytes) });
  const pdf = await task.promise;
  const result = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const text = await page.getTextContent();
    const items = text.items.flatMap(item => {
      if (!("str" in item)) return [];
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      return [{ text: item.str, x, y, width: item.width, height: item.height }];
    });
    result.push({ width: viewport.width, height: viewport.height, items, text: items.map(item => item.text).join(" ") });
  }
  await task.destroy();
  return result;
}
function cell(page: Awaited<ReturnType<typeof pages>>[number], left: number, top: number, right: number, bottom: number) {
  return page.items.filter(item => item.x >= left && item.x < right && item.y >= top && item.y <= bottom).map(item => item.text).join("").trim();
}

it("exports the Czech green opening form and exact mandatory summary C fields for an empty saved report", async () => {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-10", details };
  await generateVatReport(company.client, input);
  const pdf = await exportControlStatementPdf(company.client, input, copy);
  const xml = await exportVatReport(company.client, { ...input, format: "dphkh1" });
  if (!pdf.ok || !xml.ok) throw new Error("Export refused");
  expect(pdf.value.fileName).toBe("DPHKH1-2026-10.pdf");
  const decoded = await pages(pdf.value.bytes);
  expect(decoded).toHaveLength(2);
  expect(decoded[0].text.replace(/\s/g, "")).toContain("KONTROLNÍHLÁŠENÍ");
  expect(cell(decoded[0], 42, 348, 567, 366)).toBe("Novák s.r.o.");
  expect(cell(decoded[0], 168, 524, 567, 541)).toBe("one-off@example.test");
  expect(cell(decoded[0], 49, 749, 163, 766).replace(/\s/g, "")).toBe("03112026");
  for (const [top, bottom] of [[376, 396], [396, 416], [416, 436], [436, 456]]) expect(cell(decoded[1], 445, top, 564, bottom)).toBe("0.00");
  expect(cell(decoded[1], 445, 456, 564, 537)).toBe("");
  expect(cell(decoded[1], 502, 21, 529, 39)).toBe("2");
  expect(cell(decoded[1], 534, 21, 561, 39)).toBe("2");
  expect(decoded.map(page => page.text).join(" ")).not.toMatch(/V\s*Z\s*O\s*R|Control Statement preview/);
  expect(xml.value.xml).toContain('<VetaC obrat23="0.00" obrat5="0.00" pln23="0.00" pln5="0.00"/>');
});

it("places all supported EPO sections, rates, codes, aggregates and decimal summary in their official fields", async () => {
  const company = await administratorWithCompany();
  const cases = [
    ["A1", "outgoing", "domestic_reverse_charge", 21, "1000.00", "0.00", "1000.00"],
    ["A2", "incoming", "eu_received_service", 21, "300.00", "0.00", "300.00"],
    ["A4", "outgoing", "domestic", 21, "12000.00", "2520.00", "14520.00"],
    ["A5-one", "outgoing", "domestic", 21, "1000.00", "210.00", "1210.00"],
    ["A5-credit", "outgoing", "domestic", 21, "-100.00", "-21.00", "-121.00"],
    ["A5-zero", "outgoing", "domestic", 12, "0.05", "0.00", "0.05"],
    ["B1", "incoming", "domestic_reverse_charge", 12, "500.00", "0.00", "500.00"],
    ["B2-credit", "incoming", "domestic", 21, "-20000.00", "-4200.00", "-24200.00"],
    ["B3", "incoming", "domestic", 21, "500.00", "105.00", "605.00"],
  ] as const;
  for (const [documentNumber, direction, proposedVatRegime, rate, netAmount, vatAmount, grossAmount] of cases) {
    const created = await createManualDocument(company.client, { companyId: company.companyId, payload: {
      ...SAMPLE_EXTRACTION, documentNumber, direction, proposedVatRegime,
      documentType: netAmount.startsWith("-") ? "credit_note" : "invoice",
      reverseChargeCode: proposedVatRegime === "domestic_reverse_charge" ? "4" : null,
      supplier: direction === "outgoing" ? SAMPLE_EXTRACTION.customer : { ...SAMPLE_EXTRACTION.supplier, ...(documentNumber === "A2" ? { vatId: "DE123456789", country: "DE" } : {}) },
      customer: direction === "outgoing" ? SAMPLE_EXTRACTION.supplier : SAMPLE_EXTRACTION.customer,
      rateBreakdown: [{ rate, netAmount, vatAmount }], totals: { netAmount, vatAmount, grossAmount },
    } });
    if (!created.ok) throw new Error(created.error);
    expect(await approveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, version: 1 })).toEqual({ ok: true, value: null });
  }
  const input = { companyId: company.companyId, period: "2026-10", details };
  await generateVatReport(company.client, input);
  const pdf = await exportControlStatementPdf(company.client, input, copy);
  const xml = await exportVatReport(company.client, { ...input, format: "dphkh1" });
  if (!pdf.ok || !xml.ok) throw new Error("Export refused");
  const decoded = await pages(pdf.value.bytes);
  expect(decoded).toHaveLength(7);
  expect(decoded.map(page => Math.round(page.width))).toEqual([595, 595, 842, 842, 842, 842, 595]);
  expect(cell(decoded[1], 120, 140, 374, 154)).toBe("A1");
  expect(cell(decoded[1], 526, 21, 537, 39)).toBe("/");
  expect(cell(decoded[1], 422, 140, 502, 154)).toBe("1000.00");
  expect(cell(decoded[1], 502, 140, 564, 154)).toBe("4");
  expect(cell(decoded[2], 42, 125, 94, 138)).toBe("DE123456789");
  expect(cell(decoded[2], 94, 125, 336, 138)).toBe("A2");
  expect(cell(decoded[2], 384, 125, 461, 138)).toBe("300.00");
  expect(cell(decoded[2], 461, 125, 533, 138)).toBe("63.00");
  expect(cell(decoded[3], 94, 135, 334, 148)).toBe("A4");
  expect(cell(decoded[3], 371, 135, 441, 148)).toBe("12000.00");
  expect(cell(decoded[3], 441, 135, 509, 148)).toBe("2520.00");
  expect(cell(decoded[3], 784, 135, 810, 148)).toBe("0");
  expect(cell(decoded[3], 810, 135, 830, 148)).toBe("N");
  expect(cell(decoded[4], 510, 130, 580, 143)).toBe("500.00");
  expect(cell(decoded[4], 580, 130, 649, 143)).toBe("60.00");
  expect(cell(decoded[4], 787, 130, 830, 143)).toBe("4");
  expect(cell(decoded[5], 94, 148, 334, 161)).toBe("B2-credit");
  expect(cell(decoded[5], 371, 148, 441, 161)).toBe("-20000.00");
  expect(cell(decoded[5], 441, 148, 510, 161)).toBe("-4200.00");
  expect(cell(decoded[5], 787, 148, 808, 161)).toBe("N");
  expect(cell(decoded[5], 808, 148, 830, 161)).toBe("N");
  expect(cell(decoded[6], 27, 140, 116, 169)).toBe("900.00");
  expect(cell(decoded[6], 116, 140, 206, 169)).toBe("189.00");
  expect(cell(decoded[6], 206, 140, 296, 169)).toBe("0.05");
  expect(cell(decoded[6], 296, 140, 385, 169)).toBe("0.00");
  expect(cell(decoded[6], 27, 278, 116, 307)).toBe("500.00");
  expect(cell(decoded[6], 116, 278, 206, 307)).toBe("105.00");
  expect(cell(decoded[6], 445, 376, 564, 396)).toBe("12900.00");
  expect(cell(decoded[6], 445, 396, 564, 416)).toBe("0.05");
  expect(cell(decoded[6], 445, 416, 564, 436)).toBe("-19500.00");
  expect(cell(decoded[6], 445, 456, 564, 476)).toBe("1000.00");
  expect(cell(decoded[6], 445, 496, 564, 516)).toBe("500.00");
  expect(cell(decoded[6], 445, 516, 564, 537)).toBe("300.00");
  expect(xml.value.xml).toContain('<VetaA5 zakl_dane1="900.00" dan1="189.00" zakl_dane2="0.05" dan2="0.00"/>');
  expect(xml.value.xml).toContain('<VetaC obrat23="12900.00" obrat5="0.05" pln23="-19500.00" pln5="0.00" pln_rez_pren="1000.00" rez_pren5="500.00" celk_zd_a2="300.00"/>');
});

it.each([
  ["A1", 49, "outgoing", "domestic_reverse_charge", 140.04, 810.72, 120, 373],
  ["A2", 34, "incoming", "eu_received_service", 125.04, 553.48, 94, 335],
  ["A4", 33, "outgoing", "domestic", 135.04, 550.58, 94, 333],
  ["B1", 35, "incoming", "domestic_reverse_charge", 130.04, 571.92, 94, 333],
  ["B2", 32, "incoming", "domestic", 148.04, 550.48, 94, 333],
] as const)("continues %s at its exact form capacity without losing row identity", async (section, capacity, direction, proposedVatRegime, firstTop, lastTop, documentLeft, documentRight) => {
  const company = await administratorWithCompany();
  for (let index = 1; index <= capacity + 1; index++) {
    const created = await createManualDocument(company.client, { companyId: company.companyId, payload: {
      ...SAMPLE_EXTRACTION, documentNumber: `${section}-${String(index).padStart(3, "0")}`, direction, proposedVatRegime,
      reverseChargeCode: proposedVatRegime === "domestic_reverse_charge" ? "4" : null,
      supplier: direction === "outgoing" ? SAMPLE_EXTRACTION.customer : { ...SAMPLE_EXTRACTION.supplier, ...(section === "A2" ? { vatId: "DE123456789", country: "DE" } : {}) },
      customer: direction === "outgoing" ? SAMPLE_EXTRACTION.supplier : SAMPLE_EXTRACTION.customer,
      rateBreakdown: [{ rate: 21, netAmount: "12000.00", vatAmount: proposedVatRegime === "domestic" ? "2520.00" : "0.00" }],
      totals: { netAmount: "12000.00", vatAmount: proposedVatRegime === "domestic" ? "2520.00" : "0.00", grossAmount: proposedVatRegime === "domestic" ? "14520.00" : "12000.00" },
    } });
    if (!created.ok) throw new Error(created.error);
    const approved = await approveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, version: 1 });
    if (!approved.ok) throw new Error(approved.error);
  }
  const input = { companyId: company.companyId, period: "2026-10", details };
  await generateVatReport(company.client, input);
  const result = await exportControlStatementPdf(company.client, input, copy);
  if (!result.ok) throw new Error(result.error);
  const xml = await exportVatReport(company.client, { ...input, format: "dphkh1" });
  if (!xml.ok) throw new Error(xml.error);
  const expectedRows = [...xml.value.xml.matchAll(new RegExp(`<Veta${section} [^>]*c_evid_dd="([^"]+)"`, "g"))].map(match => match[1]);
  const decoded = await pages(result.value.bytes);
  expect(decoded).toHaveLength(4);
  expect(cell(decoded[1], documentLeft, firstTop, documentRight, firstTop + 13)).toBe(expectedRows[0]);
  expect(cell(decoded[1], documentLeft, lastTop, documentRight, lastTop + 13)).toBe(expectedRows[capacity - 1]);
  expect(cell(decoded[2], documentLeft, firstTop, documentRight, firstTop + 13)).toBe(expectedRows[capacity]);
  expect(cell(decoded[2], 14, firstTop, section === "A1" ? 67 : section === "A2" ? 43 : 52, firstTop + 13)).toBe(String(capacity + 1));
  const text = decoded.map(page => page.text).join(" ");
  for (let index = 1; index <= capacity + 1; index++) expect(text.match(new RegExp(`${section}-${String(index).padStart(3, "0")}`, "g"))).toHaveLength(1);
  expect(text).not.toMatch(/V\s*Z\s*O\s*R/);
});

it.each(["legal", "natural"] as const)("keeps saved %s identity and request-only details in full PDF and standalone opening preview", async personType => {
  const user = await provisionedUser();
  const original = companyDetails({ name: "Příliš žluťoučký kůň s.r.o.", personType, firstName: personType === "natural" ? "Jiří" : "", lastName: personType === "natural" ? "Žluťoučký" : "", streetName: "Registrovaná dlouhá adresa která je nad limitem EPO" });
  const company = await createCompany(user.client, { organizationId: user.organizationId, ...original });
  if (!company.ok) throw new Error(company.error);
  const input = { companyId: company.value.id, period: "2026-10" };
  expect(await saveCompanyFilingDefaults(user.client, { ...input, ...details, phone: "+420123456789", epoAddressOverride: { streetName: "Říční", houseNumber: "12", orientationNumber: "3A", city: "Brno", postalCode: "602 00" }, epoAddressConfirmed: true })).toEqual({ ok: true, value: null });
  await generateVatReport(user.client, input);
  expect(await updateCompanyIdentity(user.client, { ...original, companyId: company.value.id, name: "Changed identity", firstName: personType === "natural" ? "Eva" : "", lastName: personType === "natural" ? "Nová" : "" })).toEqual({ ok: true, value: null });
  const email = `${"z".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}`;
  const current = { ...input, details: { ...details, preparedOn: "2026-11-05", email, phone: "", signatoryFirstName: "Čeněk", signatoryLastName: "Řehoř", signatoryCapacity: "pověřený pracovník" } };
  const pdf = await exportControlStatementPdf(user.client, current, copy);
  const thumbnail = await exportControlStatementThumbnail(user.client, current);
  const xml = await exportVatReport(user.client, { ...current, format: "dphkh1" });
  if (!pdf.ok || !thumbnail.ok || !xml.ok) throw new Error("Export refused");
  const full = await pages(pdf.value.bytes);
  const preview = await pages(thumbnail.value.bytes);
  expect(preview).toHaveLength(1);
  expect(preview[0].items).toEqual(full[0].items);
  const opening = preview[0];
  expect(cell(opening, 49, 749, 163, 766).replace(/\s/g, "")).toBe("05112026");
  expect(cell(opening, 168, 524, 567, 541).replace(/\s/g, "")).toBe(email);
  expect(cell(opening, 42, 468, 425, 485)).toBe("Říční");
  expect(cell(opening, 439, 468, 567, 485)).toBe("12/3A");
  expect(cell(opening, 396, 496, 567, 513)).toBe("");
  expect(opening.text).not.toContain("Changed identity");
  if (personType === "legal") {
    expect(cell(opening, 42, 348, 567, 366)).toBe("Příliš žluťoučký kůň s.r.o.");
    expect(cell(opening, 49, 705, 560, 722)).toBe("Čeněk Řehoř pověřený pracovník");
  } else {
    expect(cell(opening, 42, 399, 340, 417)).toBe("Žluťoučký");
    expect(cell(opening, 354, 399, 496, 417)).toBe("Jiří");
    expect(cell(opening, 42, 348, 567, 366)).toBe("");
    expect(cell(opening, 49, 705, 560, 722)).toBe("");
  }
  for (const item of opening.items.filter(item => item.text.trim() && item.y >= 524 && item.y <= 541)) {
    if (item.x >= 168) expect(item.x + item.width).toBeLessThan(567);
  }
  expect(xml.value.xml).toContain(`email="${email}"`);
  expect(xml.value.xml).toContain('d_poddp="05.11.2026"');
  expect(xml.value.xml).toContain('ulice="Říční"');
  expect((await getCompanyFilingDefaults(user.client, input.companyId))?.email).toBe("one-off@example.test");
});

it("renders known incomplete headers and refuses another Organization or an unsaved report for both PDF transports", async () => {
  const company = await administratorWithCompany();
  const other = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-10", details: { preparedOn: "2026-11-04", email: "known@example.test" } };
  await generateVatReport(company.client, input);
  for (const exporter of [
    (client: typeof company.client, request: typeof input) => exportControlStatementPdf(client, request, copy),
    exportControlStatementThumbnail,
  ]) {
    expect(await exporter(other.client, input)).toEqual({ ok: false, error: "report_not_found" });
    expect(await exporter(company.client, { ...input, period: "2026-09" })).toEqual({ ok: false, error: "report_not_found" });
    const result = await exporter(company.client, input);
    if (!result.ok) throw new Error(result.error);
    const [opening] = await pages(result.value.bytes);
    expect(cell(opening, 42, 51, 269, 68)).toBe("");
    expect(cell(opening, 49, 705, 560, 722)).toBe("");
    expect(cell(opening, 168, 524, 567, 541)).toBe("known@example.test");
  }
  expect(await exportVatReport(company.client, { ...input, format: "dphkh1" })).toEqual({ ok: false, error: "invalid_export_details" });
  expect(await getCompanyFilingDefaults(company.client, company.companyId)).toBeNull();
});

it("lets a Company User download the saved amounts after additional Documents are approved", async () => {
  const company = await companyWithManyReportDocuments(2);
  const member = await companyMember(company);
  const [included, later] = await listCompanyDocuments(company.client, company.companyId);
  await approveDocument(company.client, { companyId: company.companyId, documentId: included.id, version: 1 });
  const input = { companyId: company.companyId, period: "2026-10", details };
  await generateVatReport(company.client, input);
  await approveDocument(company.client, { companyId: company.companyId, documentId: later.id, version: 1 });
  const result = await exportControlStatementPdf(member.client, input, copy);
  if (!result.ok) throw new Error(result.error);
  const decoded = await pages(result.value.bytes);
  expect(decoded).toHaveLength(2);
  expect(cell(decoded[1], 27, 278, 116, 307)).toBe("1000.00");
  expect(cell(decoded[1], 116, 278, 206, 307)).toBe("210.00");
});

it("keeps a long Czech document identifier, both rate columns and nonzero bases with zero VAT together in one detail row", async () => {
  const company = await administratorWithCompany();
  const documentNumber = "Č".repeat(60);
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: {
    ...SAMPLE_EXTRACTION, documentNumber, direction: "incoming", proposedVatRegime: "domestic",
    rateBreakdown: [{ rate: 21, netAmount: "12000.00", vatAmount: "2520.00" }, { rate: 12, netAmount: "0.05", vatAmount: "0.00" }],
    totals: { netAmount: "12000.05", vatAmount: "2520.00", grossAmount: "14520.05" },
  } });
  if (!created.ok) throw new Error(created.error);
  const approved = await approveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, version: 1 });
  if (!approved.ok) throw new Error(approved.error);
  const input = { companyId: company.companyId, period: "2026-10", details };
  await generateVatReport(company.client, input);
  const pdf = await exportControlStatementPdf(company.client, input, copy);
  const xml = await exportVatReport(company.client, { ...input, format: "dphkh1" });
  if (!pdf.ok || !xml.ok) throw new Error("Export refused");
  const decoded = await pages(pdf.value.bytes);
  expect(decoded).toHaveLength(3);
  expect(cell(decoded[1], 94, 148, 334, 161).replace(/\s/g, "")).toBe(documentNumber);
  expect(cell(decoded[1], 371, 148, 441, 161)).toBe("12000.00");
  expect(cell(decoded[1], 441, 148, 510, 161)).toBe("2520.00");
  expect(cell(decoded[1], 510, 148, 580, 161)).toBe("0.05");
  expect(cell(decoded[1], 580, 148, 649, 161)).toBe("0.00");
  expect(cell(decoded[1], 649, 148, 787, 161)).toBe("");
  for (const item of decoded[1].items.filter(item => item.text.trim() && item.x >= 94 && item.x < 334 && item.y >= 148 && item.y <= 161)) expect(item.x + item.width).toBeLessThan(334);
  expect(xml.value.xml).toContain('zakl_dane1="12000.00" dan1="2520.00" zakl_dane2="0.05" dan2="0.00"');
});
