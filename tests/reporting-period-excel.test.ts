import * as XLSX from "xlsx";
import { expect, it } from "vitest";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { exportReportingPeriodWorkbook } from "@/application/reporting-period-excel";
import { createCompany, enableAiProcessing } from "@/application/companies";
import { approveDocument, listDocuments } from "@/application/documents";
import { uploadSourceFile } from "@/application/source-files";
import { administratorWithCompany, companyDetails, companyMember } from "./support/fixtures";
import { signedUpUser } from "./support/clients";
import { fixtureFile } from "./support/files";
import { systemClient, testWorker } from "./support/worker";

const COLUMNS = [
  "Document ID",
  "Document number",
  "Direction",
  "Tax Point Date",
  "Counterparty",
  "VAT Regime",
  "VAT Return line",
  "Control Statement section",
  "VAT rate (%)",
  "Net amount",
  "VAT amount",
  "Gross amount",
  "Currency",
  "Status",
  "Findings",
];

async function companyWithOverviewDocuments() {
  const payloads = [
    { ...SAMPLE_EXTRACTION, documentNumber: "APPROVED-1" },
    { ...SAMPLE_EXTRACTION, documentNumber: "WAITING-1" },
    {
      ...SAMPLE_EXTRACTION,
      documentNumber: "FINDING-1",
      supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: "CZ27082441" },
    },
  ];
  let extraction = 0;
  const worker = testWorker(fakeAiProvider({ extract: () => payloads[extraction++] }));
  const administrator = await administratorWithCompany();
  await enableAiProcessing(administrator.client, worker.jobs, {
    companyId: administrator.companyId,
    provider: worker.ai,
  });
  const documentIds: string[] = [];
  for (let index = 0; index < payloads.length; index++) {
    const uploaded = await uploadSourceFile(administrator.client, worker.jobs, {
      companyId: administrator.companyId,
      fileName: `invoice-${index + 1}.png`,
      bytes: fixtureFile("receipt.png"),
      preselectedDirection: "incoming",
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect(await worker.runJobs()).toEqual([]);
    const [document] = await listDocuments(administrator.client, administrator.companyId, uploaded.value.id);
    documentIds.push(document.id);
  }
  for (const index of [0, 2]) {
    expect(await approveDocument(administrator.client, {
      companyId: administrator.companyId,
      documentId: documentIds[index],
      version: 1,
    })).toEqual({ ok: true, value: null });
  }
  return { ...administrator, documentIds };
}

it("exports the Reporting Period overview with approved and attention sheets", async () => {
  const company = await companyWithOverviewDocuments();
  const user = await companyMember(company);

  const result = await exportReportingPeriodWorkbook(user.client, {
    companyId: company.companyId,
    period: "2026-10",
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value).toEqual(expect.objectContaining({
    fileName: "VAT-overview-2026-10.xlsx",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }));
  const workbook = XLSX.read(result.value.bytes, { type: "array" });
  expect(workbook.SheetNames).toEqual(["Included", "Attention"]);
  for (const sheetName of workbook.SheetNames) {
    const [headers] = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1 });
    expect(headers).toEqual(COLUMNS);
  }
  const included = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Included, { defval: "" });
  expect(included).toEqual([{
    "Document ID": company.documentIds[0],
    "Document number": "APPROVED-1",
    Direction: "incoming",
    "Tax Point Date": "2026-10-01",
    Counterparty: "Dodavatel s.r.o.",
    "VAT Regime": "domestic",
    "VAT Return line": "40",
    "Control Statement section": "B.3",
    "VAT rate (%)": 21,
    "Net amount": 1000,
    "VAT amount": 210,
    "Gross amount": 1210,
    Currency: "CZK",
    Status: "approved",
    Findings: "",
  }]);
  const attention = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Attention, { defval: "" });
  expect(attention).toEqual(expect.arrayContaining([
    expect.objectContaining({
      "Document ID": company.documentIds[1],
      "Document number": "WAITING-1",
      Status: "needs_review",
      Findings: "",
      "VAT Return line": "",
      "Control Statement section": "",
    }),
    expect.objectContaining({
      "Document ID": company.documentIds[2],
      "Document number": "FINDING-1",
      Status: "approved",
      Findings: "error: invalid_vat_id_checksum (supplier.vatId)",
      "VAT Return line": "40",
      "Control Statement section": "B.3",
    }),
  ]));
  expect(attention).toHaveLength(2);
});

it("classifies a quarterly Company's Documents on VAT Return lines and Control Statement sections", async () => {
  const owner = await signedUpUser("Quarterly Organization");
  const created = await createCompany(owner.client, {
    organizationId: owner.organizationId,
    ...companyDetails({
      filingFrequency: "quarterly",
      filingFrequencyEffectiveFrom: "2027-01-01",
    }),
  });
  if (!created.ok) throw new Error(created.error);
  const worker = testWorker(fakeAiProvider({
    extract: () => ({ ...SAMPLE_EXTRACTION, taxPointDate: "2027-02-10" }),
  }));
  await enableAiProcessing(owner.client, worker.jobs, {
    companyId: created.value.id,
    provider: worker.ai,
  });
  const uploaded = await uploadSourceFile(owner.client, worker.jobs, {
    companyId: created.value.id,
    fileName: "quarterly.png",
    bytes: fixtureFile("receipt.png"),
    preselectedDirection: "incoming",
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(owner.client, created.value.id, uploaded.value.id);
  expect(await approveDocument(owner.client, {
    companyId: created.value.id,
    documentId: document.id,
    version: 1,
  })).toEqual({ ok: true, value: null });

  const result = await exportReportingPeriodWorkbook(owner.client, {
    companyId: created.value.id,
    period: "2027-Q1",
  });
  if (!result.ok) throw new Error(result.error);
  const workbook = XLSX.read(result.value.bytes, { type: "array" });
  const [row] = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Included);
  expect(row).toEqual(expect.objectContaining({
    "VAT Return line": "40",
    "Control Statement section": "B.3",
  }));
});

it("uses filing-frequency history beyond the API row limit for quarterly classification", async () => {
  const company = await administratorWithCompany("Long Filing History");
  const monthlyHistory = Array.from({ length: 999 }, (_, index) => {
    const effectiveFrom = new Date(Date.UTC(2027, 0, index + 1)).toISOString().slice(0, 10);
    return {
      company_id: company.companyId,
      organization_id: company.organizationId,
      frequency: "monthly" as const,
      effective_from: effectiveFrom,
    };
  });
  const inserted = await systemClient().from("company_filing_frequency").insert([
    ...monthlyHistory,
    {
      company_id: company.companyId,
      organization_id: company.organizationId,
      frequency: "quarterly",
      effective_from: "2030-01-01",
    },
  ]);
  if (inserted.error) throw inserted.error;
  const worker = testWorker(fakeAiProvider({
    extract: () => ({ ...SAMPLE_EXTRACTION, taxPointDate: "2030-02-10" }),
  }));
  await enableAiProcessing(company.client, worker.jobs, {
    companyId: company.companyId,
    provider: worker.ai,
  });
  const uploaded = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "late-quarterly.png",
    bytes: fixtureFile("receipt.png"),
    preselectedDirection: "incoming",
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(company.client, company.companyId, uploaded.value.id);
  expect(await approveDocument(company.client, {
    companyId: company.companyId,
    documentId: document.id,
    version: 1,
  })).toEqual({ ok: true, value: null });

  const result = await exportReportingPeriodWorkbook(company.client, {
    companyId: company.companyId,
    period: "2030-Q1",
  });
  if (!result.ok) throw new Error(result.error);
  const workbook = XLSX.read(result.value.bytes, { type: "array" });
  const [row] = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Included);
  expect(row).toEqual(expect.objectContaining({
    "Document ID": document.id,
    "VAT Return line": "40",
    "Control Statement section": "B.3",
  }));
});

it("refuses an invalid Reporting Period and another Organization", async () => {
  const company = await administratorWithCompany();
  const outsider = await signedUpUser();

  expect(await exportReportingPeriodWorkbook(company.client, {
    companyId: company.companyId,
    period: "2026-13",
  })).toEqual({ ok: false, error: "invalid_reporting_period" });
  expect(await exportReportingPeriodWorkbook(outsider.client, {
    companyId: company.companyId,
    period: "2026-10",
  })).toEqual({ ok: false, error: "forbidden" });
});
