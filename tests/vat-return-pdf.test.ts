import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  createVatReturnPdf,
  exportVatReturnPdf,
} from "@/application/vat-return-pdf";
import { vatReturnPreviewData } from "@/application/vat-return-preview";
import type { ComputedVatReport } from "@/application/vat-rules";
import { generateVatReport } from "@/application/vat-reports";
import {
  administratorWithCompany,
  companyMember,
  companyWithManyReportDocuments,
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
    ico: "12345678",
    vatId: "CZ12345678",
    street: "Říční 1",
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
