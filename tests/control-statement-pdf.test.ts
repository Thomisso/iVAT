import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  createControlStatementPdf,
  exportControlStatementPdf,
} from "@/application/control-statement-pdf";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { createManualDocument } from "@/application/documents";
import { exportVatReport } from "@/application/epo-export";
import { controlStatementPreviewData } from "@/application/control-statement-preview";
import {
  approveDocument,
  listCompanyDocuments,
} from "@/application/documents";
import type { ComputedVatReport } from "@/application/vat-rules";
import { generateVatReport } from "@/application/vat-reports";
import {
  administratorWithCompany,
  companyMember,
  companyWithManyReportDocuments,
} from "./support/fixtures";
import czechMessages from "../messages/cs.json";
import englishMessages from "../messages/en.json";

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
  vatReturn: [],
  controlStatement: [
    {
      section: "A.4",
      counterpartyVatId: "CZ87654321",
      counterpartyCountry: null,
      documentNumber: "2026-001",
      taxPointDate: "2026-10-10",
      reverseChargeCode: null,
      rateBreakdown: [
        {
          rate: 21,
          netAmount: "1000.00",
          vatAmount: "210.00",
          documentIds: ["document-1"],
        },
        {
          rate: 12,
          netAmount: "500.00",
          vatAmount: "60.00",
          documentIds: ["document-1"],
        },
      ],
      documentIds: ["document-1"],
    },
    {
      section: "B.3",
      counterpartyVatId: null,
      counterpartyCountry: null,
      documentNumber: null,
      taxPointDate: null,
      reverseChargeCode: null,
      rateBreakdown: [
        {
          rate: 21,
          netAmount: "300.00",
          vatAmount: "63.00",
          documentIds: ["document-2"],
        },
      ],
      documentIds: ["document-2"],
    },
  ],
  totals: {
    outputVat: "270.00",
    inputVat: "63.00",
    payable: "207.00",
    excessDeduction: "0.00",
  },
  totalDocumentIds: {
    outputVat: ["document-1"],
    inputVat: ["document-2"],
    payable: ["document-1", "document-2"],
    excessDeduction: [],
  },
  excludedDocuments: [],
};

async function pdfPages(bytes: Uint8Array) {
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
  return pages;
}

async function pdfText(bytes: Uint8Array) {
  return (await pdfPages(bytes)).join("\n");
}

it("renders saved Control Statement identity, sections, entries and totals", async () => {
  const preview = controlStatementPreviewData(report);

  expect(preview.totals).toEqual({ netAmount: "1800.00", vatAmount: "333.00" });

  const text = await pdfText(
    await createControlStatementPdf(
      preview,
      englishMessages.vatReports.controlStatementPdf,
    ),
  );
  for (const literal of [
    "iVAT · Control Statement preview",
    "Příliš žluťoučký kůň s.r.o.",
    "CZ12345678",
    "12345678",
    "Říční 1",
    "602 00 Brno",
    "Reporting Period: 2026-10",
    "Section A.4",
    "2026-001",
    "CZ87654321",
    "10.10.2026",
    "21%",
    "1000.00",
    "210.00",
    "12%",
    "500.00",
    "60.00",
    "Section B.3",
    "300.00",
    "63.00",
    "Statement totals",
    "1800.00",
    "333.00",
  ]) {
    expect(text).toContain(literal);
  }
});

it("groups multiple entries into one ordered section with section totals", async () => {
  const groupedReport: ComputedVatReport = { ...report, controlStatement: [
    report.controlStatement[1], report.controlStatement[0],
    { ...report.controlStatement[0], documentNumber: "CREDIT-002", documentIds: ["document-3"], rateBreakdown: [
      { rate: 21, netAmount: "-100.00", vatAmount: "-21.00", documentIds: ["document-3"] },
    ] },
  ] };
  const before = JSON.stringify(groupedReport);
  const text = await pdfText(await createControlStatementPdf(controlStatementPreviewData(groupedReport), englishMessages.vatReports.controlStatementPdf));
  expect(text.match(/Section A\.4/g)).toHaveLength(1);
  expect(text.match(/Section B\.3/g)).toHaveLength(1);
  expect(text.indexOf("Section A.4")).toBeLessThan(text.indexOf("Section B.3"));
  expect(text.match(/Section totals/g)).toHaveLength(2);
  for (const literal of ["2026-001", "CREDIT-002", "1400.00", "249.00", "300.00", "63.00", "1700.00", "312.00"]) expect(text).toContain(literal);
  expect(JSON.stringify(groupedReport)).toBe(before);
});

it("orders all supported sections and omits every empty section", async () => {
  const sections = ["B.3", "A.5", "B.1", "A.2", "A.4", "B.2", "A.1"] as const;
  const preview = controlStatementPreviewData({ ...report, controlStatement: sections.map(section => ({ ...report.controlStatement[0], section })) });
  expect(preview.sections.map(section => section.section)).toEqual(["A.1", "A.2", "A.4", "A.5", "B.1", "B.2", "B.3"]);
  const rendered = await pdfText(await createControlStatementPdf(preview, englishMessages.vatReports.controlStatementPdf));
  expect(rendered.match(/Section [AB]\.\d/g)).toEqual(["Section A.1", "Section A.2", "Section A.4", "Section A.5", "Section B.1", "Section B.2", "Section B.3"]);
  const empty = controlStatementPreviewData({ ...report, controlStatement: [] });
  expect(empty.sections).toEqual([]);
  expect(empty.totals).toEqual({ netAmount: "0.00", vatAmount: "0.00" });
  const text = await pdfText(await createControlStatementPdf(empty, englishMessages.vatReports.controlStatementPdf));
  expect(text).toContain("No included Documents.");
  expect(text).not.toMatch(/Section [AB]\./);
});

it("continues a section across PDF pages without repeating its heading or losing entries", async () => {
  const entries = Array.from({ length: 45 }, (_, index) => ({ ...report.controlStatement[0], documentNumber: `PAGE-${String(index + 1).padStart(3, "0")}` }));
  const text = await pdfText(await createControlStatementPdf(controlStatementPreviewData({ ...report, controlStatement: entries }), englishMessages.vatReports.controlStatementPdf));
  expect(text.split("\n").length).toBeGreaterThan(1);
  expect(text.match(/Section A\.4/g)).toHaveLength(1);
  expect(text.match(/Document: PAGE-/g)).toHaveLength(45);
  expect(text).toContain("67500.00");
  expect(text).toContain("12150.00");
});

it("keeps a section heading with its first entry at a PDF page boundary", async () => {
  const first = report.controlStatement[0];
  const boundaryReport: ComputedVatReport = { ...report, controlStatement: [
    ...Array.from({ length: 4 }, (_, index) => ({
      ...first, documentNumber: `A4-${index + 1}`,
      rateBreakdown: index === 0 ? first.rateBreakdown : [first.rateBreakdown[0]],
    })),
    { ...first, section: "B.2", documentNumber: "B2-FIRST", rateBreakdown: [first.rateBreakdown[0]] },
  ] };
  const pages = await pdfPages(await createControlStatementPdf(controlStatementPreviewData(boundaryReport), englishMessages.vatReports.controlStatementPdf));
  expect(pages).toHaveLength(2);
  expect(pages[0]).not.toContain("Section B.2");
  expect(pages[1]).toContain("Section B.2");
  expect(pages[1]).toContain("Document: B2-FIRST");
  expect(pages.join(" ").match(/Section B\.2/g)).toHaveLength(1);
});

it("omits historical zero rows from preview and PDF while preserving zero VAT, negatives and the snapshot", async () => {
  const historical: ComputedVatReport = { ...report, controlStatement: [{ ...report.controlStatement[0], rateBreakdown: [
    { rate: 0, netAmount: "0.00", vatAmount: "0.00", documentIds: [] },
    { rate: 21, netAmount: "1000.00", vatAmount: "210.00", documentIds: ["one"] },
    { rate: 12, netAmount: "50.00", vatAmount: "0.00", documentIds: ["two"] },
    { rate: 12, netAmount: "-100.00", vatAmount: "-12.00", documentIds: ["three"] },
  ] }] };
  const preview = controlStatementPreviewData(historical);
  expect(preview.sections[0].entries[0].rateBreakdown).toHaveLength(3);
  expect(preview.totals).toEqual({ netAmount: "950.00", vatAmount: "198.00" });
  const text = await pdfText(await createControlStatementPdf(preview, englishMessages.vatReports.controlStatementPdf));
  expect(text).toContain("50.00");
  expect(text).toContain("-100.00");
  expect(text).toContain("-12.00");
  expect(text).not.toContain("0%");
  expect(historical.controlStatement[0].rateBreakdown).toHaveLength(4);
});

it("renders every PDF-visible label in Czech when the route supplies Czech copy", async () => {
  const text = await pdfText(
    await createControlStatementPdf(
      controlStatementPreviewData(report),
      czechMessages.vatReports.controlStatementPdf,
    ),
  );

  for (const literal of [
    "iVAT · Náhled kontrolního hlášení",
    "Daňové identifikační číslo: CZ12345678",
    "Adresa: Říční 1",
    "Zdaňovací období: 2026-10",
    "Oddíl A.4",
    "Doklad: 2026-001",
    "Daňové identifikační číslo protistrany: CZ87654321",
    "Datum uskutečnění zdanitelného plnění: 10.10.2026",
    "Sazba",
    "Základ daně (Kč)",
    "DPH (Kč)",
    "Součty kontrolního hlášení",
  ]) {
    expect(text).toContain(literal);
  }
  expect(text).not.toContain("Reporting Period");
  expect(text).not.toContain("Statement totals");
});

it("a Company User downloads the saved Control Statement snapshot as a PDF", async () => {
  const company = await companyWithManyReportDocuments(2);
  const member = await companyMember(company);
  const input = { companyId: company.companyId, period: "2026-10" };
  const [included, approvedLater] = await listCompanyDocuments(
    company.client,
    company.companyId,
  );
  const includedResult = await approveDocument(company.client, {
    companyId: company.companyId,
    documentId: included.id,
    version: 1,
  });
  expect(includedResult.ok).toBe(true);
  await generateVatReport(company.client, input);
  const laterResult = await approveDocument(company.client, {
    companyId: company.companyId,
    documentId: approvedLater.id,
    version: 1,
  });
  expect(laterResult.ok).toBe(true);

  const result = await exportControlStatementPdf(
    member.client,
    input,
    englishMessages.vatReports.controlStatementPdf,
  );

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.fileName).toBe("DPHKH1-2026-10.pdf");
  expect(result.value.mediaType).toBe("application/pdf");
  expect(new TextDecoder().decode(result.value.bytes.slice(0, 5))).toBe("%PDF-");
  const text = await pdfText(result.value.bytes);
  expect(text).toContain("Novák s.r.o.");
  expect(text).toContain("Section B.3");
  expect(text).toContain("1000.00");
  expect(text).toContain("210.00");
  expect(text).not.toContain("2000.00");
  expect(text).not.toContain("420.00");
});

it("does not expose another Organization's Control Statement PDF", async () => {
  const owner = await administratorWithCompany();
  const other = await administratorWithCompany();
  const input = { companyId: owner.companyId, period: "2026-10" };
  await generateVatReport(owner.client, input);

  expect(
    await exportControlStatementPdf(
      other.client,
      input,
      englishMessages.vatReports.controlStatementPdf,
    ),
  ).toEqual({
    ok: false,
    error: "report_not_found",
  });
});


it("exports mandatory summary C zeros without fabricating optional values for an empty report", async () => {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-10", details: {
    preparedOn: "2026-11-03", taxOffice: "451", economicActivity: "621000", email: "one-off@example.test",
    signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
  } };
  await generateVatReport(company.client, input);
  const pdf = await exportControlStatementPdf(company.client, input, czechMessages.vatReports.controlStatementPdf);
  const xml = await exportVatReport(company.client, { ...input, format: "dphkh1" });
  if (!pdf.ok || !xml.ok) throw new Error("Export refused");
  const text = await pdfText(pdf.value.bytes);
  expect(text).toMatch(/Souhrn C\s+Řádek 1 – základ daně\s+0.00\s+Řádek 2 – základ daně\s+0.00\s+Řádek 40 – základ daně\s+0.00\s+Řádek 41 – základ daně\s+0.00/);
  expect(text).toContain("03.11.2026");
  expect(text).toContain("one-off@example.test");
  expect(text).not.toContain("Řádek 25 – základ daně");
  expect(xml.value.xml).toContain('<VetaC obrat23="0.00" obrat5="0.00" pln23="0.00" pln5="0.00"/>');
});


it("preserves all XML sections, aggregate rates, negative amounts and nonzero bases with zero VAT in the downloaded PDF", async () => {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-10", details: {
    preparedOn: "2026-11-04", taxOffice: "451", economicActivity: "621000",
    signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
  } };
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
      supplier: direction === "outgoing" ? SAMPLE_EXTRACTION.customer : {
        ...SAMPLE_EXTRACTION.supplier,
        ...(documentNumber === "A2" ? { vatId: "DE123456789", country: "DE" } : {}),
      },
      customer: direction === "outgoing" ? SAMPLE_EXTRACTION.supplier : SAMPLE_EXTRACTION.customer,
      rateBreakdown: [{ rate, netAmount, vatAmount }], totals: { netAmount, vatAmount, grossAmount },
    } });
    if (!created.ok) throw new Error(created.error);
    expect(await approveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, version: 1 })).toEqual({ ok: true, value: null });
  }
  await generateVatReport(company.client, input);
  const pdf = await exportControlStatementPdf(company.client, input, czechMessages.vatReports.controlStatementPdf);
  const xml = await exportVatReport(company.client, { ...input, format: "dphkh1" });
  if (!pdf.ok || !xml.ok) throw new Error("Export refused");
  const text = await pdfText(pdf.value.bytes);
  const detailText = text.split("Souhrn C")[0];
  expect(detailText.match(/Oddíl [AB]\.\d(?=\s)/g)).toEqual(["Oddíl A.1", "Oddíl A.2", "Oddíl A.4", "Oddíl A.5", "Oddíl B.1", "Oddíl B.2", "Oddíl B.3"]);
  const sections = detailText.split(/Oddíl [AB]\.\d(?=\s)/).slice(1);
  expect(sections[0]).toMatch(/Základ daně \(Kč\)\s+1000.00/);
  expect(sections[0]).not.toContain("DPH 21 %");
  expect(sections[1]).toMatch(/Základ daně 21 %\s+300.00\s+DPH 21 %\s+63.00/);
  expect(sections[2]).toMatch(/Základ daně 21 %\s+12000.00\s+DPH 21 %\s+2520.00/);
  expect(sections[3]).toMatch(/Základ daně 21 %\s+900.00\s+DPH 21 %\s+189.00\s+Základ daně 12 %\s+0.05\s+DPH 12 %\s+0.00/);
  expect(sections[4]).toMatch(/Základ daně 12 %\s+500.00\s+DPH 12 %\s+60.00/);
  expect(sections[5]).toMatch(/Základ daně 21 %\s+-20000.00\s+DPH 21 %\s+-4200.00/);
  expect(sections[6]).toMatch(/Základ daně 21 %\s+500.00\s+DPH 21 %\s+105.00/);
  expect(text).toMatch(/Souhrn C\s+Řádek 1 – základ daně\s+12900.00\s+Řádek 2 – základ daně\s+0.05/);
  expect(xml.value.xml).toContain('<VetaA5 zakl_dane1="900.00" dan1="189.00" zakl_dane2="0.05" dan2="0.00"/>');
  expect(xml.value.xml).toMatch(/<VetaB2 [^>]*zakl_dane1="-20000.00" dan1="-4200.00"/);
  expect(xml.value.xml).toContain('<VetaC obrat23="12900.00" obrat5="0.05" pln23="-19500.00" pln5="0.00" pln_rez_pren="1000.00" rez_pren5="500.00" celk_zd_a2="300.00"/>');
});
