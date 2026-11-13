import { unzipSync, strFromU8 } from "fflate";
import { expect, it } from "vitest";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { exportCompanyData, getCompanyDataExportStatus, softDeleteCompany } from "@/application/company-deletion";
import { exportVatReport, readVatReportArtifact } from "@/application/epo-export";
import { exportVatReturnPdf } from "@/application/vat-return-pdf";
import { generateVatReport } from "@/application/vat-reports";
import { administratorWithCompany } from "./support/fixtures";
import { testWorker } from "./support/worker";

const representative = { code: "4a", personType: "F", firstName: "Alena", lastName: "Zástupná", birthDate: "1981-02-03", evidenceNumber: "" } as const;
const filing = { taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", signatoryFirstName: "Jana", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka", email: "", phone: "", epoAddressOverride: null };

it("includes the saved Representation Profile and exact immutable XML/PDF bytes in a worker-verified Company archive", async () => {
  const company = await administratorWithCompany();
  expect(await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative })).toEqual({ ok: true, value: null });
  expect((await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" })).ok).toBe(true);
  const input = { companyId: company.companyId, period: "2026-10", details: { preparedOn: "2026-10-27" } };
  const xml = await exportVatReport(company.client, { ...input, format: "dphdp3" });
  const pdf = await exportVatReturnPdf(company.client, input);
  if (!xml.ok || !pdf.ok || !pdf.value.artifactId) throw new Error("VAT artifacts were not created");
  const storedXml = await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: xml.value.artifactId });
  if (!storedXml) throw new Error("XML artifact not retained");
  const worker = testWorker();
  const download = await exportCompanyData(company.client, worker.jobs, { companyId: company.companyId });
  if (!download.ok) throw new Error(download.error);
  const archive = unzipSync(download.value.bytes);
  expect(JSON.parse(strFromU8(archive["company.json"])).filingDefaults.representative).toEqual(representative);
  expect(archive[`vat-report-artifacts/${xml.value.artifactId}/${xml.value.fileName}`]).toEqual(storedXml.bytes);
  expect(archive[`vat-report-pdf-artifacts/${pdf.value.artifactId}/${pdf.value.fileName}`]).toEqual(pdf.value.bytes);
  expect(JSON.parse(strFromU8(archive["vat-report-pdf-artifacts.json"]))).toEqual([
    expect.objectContaining({ id: pdf.value.artifactId, format: "dphdp3", kind: "draft", resolvedDetails: expect.objectContaining({ representative }), authorUserId: company.userId, serializerVersion: "3" }),
  ]);
  expect(await worker.runJobs()).toEqual([]);
  expect(await getCompanyDataExportStatus(company.client, { companyId: company.companyId, exportId: download.value.exportId })).toEqual({ ok: true, value: "completed" });
});

it("makes a completed Company archive stale when another immutable PDF is created before deletion", async () => {
  const company = await administratorWithCompany();
  expect((await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" })).ok).toBe(true);
  const worker = testWorker();
  const download = await exportCompanyData(company.client, worker.jobs, { companyId: company.companyId });
  if (!download.ok) throw new Error(download.error);
  expect(await worker.runJobs()).toEqual([]);
  const receipt = { companyId: company.companyId, exportId: download.value.exportId };
  expect(await getCompanyDataExportStatus(company.client, receipt)).toEqual({ ok: true, value: "completed" });
  const pdf = await exportVatReturnPdf(company.client, { companyId: company.companyId, period: "2026-10", details: { preparedOn: "2026-10-27" } });
  expect(pdf.ok).toBe(true);
  expect(await getCompanyDataExportStatus(company.client, receipt)).toEqual({ ok: true, value: "stale" });
  expect(await softDeleteCompany(company.client, receipt)).toEqual({ ok: false, error: "stale_export" });
});
