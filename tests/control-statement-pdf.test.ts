import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  createControlStatementPdf,
  exportControlStatementPdf,
} from "@/application/control-statement-pdf";
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
