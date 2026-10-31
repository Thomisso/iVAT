import { strFromU8, unzipSync } from "fflate";
import { expect, it } from "vitest";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { setCurrentReportingYear } from "@/application/companies";
import { exportCompanyData } from "@/application/company-deletion";
import {
  exportFinalVatReport,
  exportVatReport,
  listVatReportArtifacts,
  readVatReportArtifact,
} from "@/application/epo-export";
import {
  finalizeVatReport,
  generateVatReport,
  unlockReportingPeriod,
} from "@/application/vat-reports";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { testWorker } from "./support/worker";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { approveDocument, correctDocument, getDocument, listCompanyDocuments, listExtractionVersions, rejectDocument } from "@/application/documents";
import { defineSourceDocuments, readSourceFile, uploadSourceFile } from "@/application/source-files";
import { fixtureFile, multiSheetWorkbookFile } from "./support/files";
import { getVatReport } from "@/application/vat-reports";

const filingDefaults = {
  taxOffice: "451",
  territorialOffice: "2003",
  economicActivity: "621000",
  signatoryFirstName: "Jana",
  signatoryLastName: "Nováková",
  signatoryCapacity: "jednatelka",
  email: "podatelna@example.test",
  phone: "+420123456789",
  epoAddressOverride: null,
};
const exportDetails = { preparedOn: "2026-10-29" };

async function preparedCompany(period = "2026-10") {
  const company = await administratorWithCompany();
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId,
    ...filingDefaults,
  })).toEqual({ ok: true, value: null });
  expect(await generateVatReport(company.client, {
    companyId: company.companyId,
    period,
  })).toEqual({ ok: true, value: { id: expect.any(String) } });
  return company;
}

it.each(["dphdp3", "dphkh1"] as const)(
  "creates a new immutable final %s artifact only for the finalized current snapshot",
  async (format) => {
    const company = await preparedCompany();
    const user = await companyMember(company);
    expect(await exportFinalVatReport(user.client, {
      companyId: company.companyId,
      period: "2026-10",
      format,
      details: exportDetails,
    })).toEqual({ ok: false, error: "report_not_finalized" });

    const draft = await exportVatReport(user.client, {
      companyId: company.companyId,
      period: "2026-10",
      format,
      details: exportDetails,
    });
    if (!draft.ok) throw new Error(draft.error);
    expect(await finalizeVatReport(company.client, {
      companyId: company.companyId,
      period: "2026-10",
      confirmed: true,
    })).toEqual({ ok: true, value: null });

    const final = await exportFinalVatReport(user.client, {
      companyId: company.companyId,
      period: "2026-10",
      format,
      details: { ...exportDetails, email: "final@example.test" },
    });
    if (!final.ok) throw new Error(final.error);
    expect(final.value.fileName).toBe(`${format.toUpperCase()}_2026-10.xml`);
    expect(final.value.fileName).not.toContain("DRAFT_");
    expect(final.value.artifactId).not.toBe(draft.value.artifactId);

    expect(await unlockReportingPeriod(company.client, {
      companyId: company.companyId,
      period: "2026-10",
      reason: "Correct source data",
      confirmed: true,
    })).toEqual({ ok: true, value: null });
    expect(await saveCompanyFilingDefaults(company.client, {
      companyId: company.companyId,
      ...filingDefaults,
      email: "changed-after-export@example.test",
    })).toEqual({ ok: true, value: null });

    const history = await listVatReportArtifacts(user.client, {
      companyId: company.companyId,
      period: "2026-10",
    });
    expect(history.map(({ id, kind, resolvedDetails }) => ({
      id,
      kind,
      email: resolvedDetails.email,
    }))).toEqual([
      { id: final.value.artifactId, kind: "final", email: "final@example.test" },
      { id: draft.value.artifactId, kind: "draft", email: "podatelna@example.test" },
    ]);
  },
);

it("stores and downloads quarterly VAT Return draft and final XML artifacts", async () => {
  const company = await administratorWithCompany();
  expect(await setCurrentReportingYear(company.client, {
    companyId: company.companyId,
    filingFrequency: "quarterly",
    year: 2026,
  })).toEqual({ ok: true, value: null });
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId,
    ...filingDefaults,
  })).toEqual({ ok: true, value: null });
  expect(await generateVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-Q4",
  })).toEqual({ ok: true, value: { id: expect.any(String) } });
  expect(await generateVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-Q5",
  })).toEqual({ ok: false, error: "invalid_reporting_period" });

  const user = await companyMember(company);
  const draft = await exportVatReport(user.client, {
    companyId: company.companyId,
    period: "2026-Q4",
    format: "dphdp3",
    details: exportDetails,
  });
  if (!draft.ok) throw new Error(draft.error);
  expect(draft.value.fileName).toBe("DRAFT_DPHDP3_2026-Q4.xml");
  expect(draft.value.mediaType).toBe("application/xml; charset=utf-8");
  expect(await readVatReportArtifact(user.client, {
    companyId: company.companyId,
    artifactId: draft.value.artifactId,
  })).toEqual({
    artifact: expect.objectContaining({
      period: "2026-Q4",
      format: "dphdp3",
      kind: "draft",
      fileName: "DRAFT_DPHDP3_2026-Q4.xml",
      mediaType: "application/xml; charset=utf-8",
    }),
    bytes: draft.value.bytes,
  });

  expect(await finalizeVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-Q4",
    confirmed: true,
  })).toEqual({ ok: true, value: null });
  const final = await exportFinalVatReport(user.client, {
    companyId: company.companyId,
    period: "2026-Q4",
    format: "dphdp3",
    details: exportDetails,
  });
  if (!final.ok) throw new Error(final.error);
  expect(final.value.fileName).toBe("DPHDP3_2026-Q4.xml");
  expect(final.value.mediaType).toBe("application/xml; charset=utf-8");
  expect(await readVatReportArtifact(user.client, {
    companyId: company.companyId,
    artifactId: final.value.artifactId,
  })).toEqual({
    artifact: expect.objectContaining({
      period: "2026-Q4",
      format: "dphdp3",
      kind: "final",
      fileName: "DPHDP3_2026-Q4.xml",
      mediaType: "application/xml; charset=utf-8",
    }),
    bytes: final.value.bytes,
  });
});

it("puts VAT Reports, lock history, artifact metadata and exact XML bytes in the Company archive", async () => {
  const company = await preparedCompany();
  const draft = await exportVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-10",
    format: "dphdp3",
    details: exportDetails,
  });
  if (!draft.ok) throw new Error(draft.error);
  expect(await finalizeVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-10",
    confirmed: true,
  })).toEqual({ ok: true, value: null });
  const final = await exportFinalVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-10",
    format: "dphdp3",
    details: exportDetails,
  });
  if (!final.ok) throw new Error(final.error);
  expect(await unlockReportingPeriod(company.client, {
    companyId: company.companyId,
    period: "2026-10",
    reason: "Archive preserves this transition",
    confirmed: true,
  })).toEqual({ ok: true, value: null });

  const worker = testWorker();
  const exported = await exportCompanyData(company.client, worker.jobs, {
    companyId: company.companyId,
  });
  if (!exported.ok) throw new Error(exported.error);
  expect(await worker.runJobs()).toEqual([]);
  const archive = unzipSync(exported.value.bytes);
  const reports = JSON.parse(strFromU8(archive["vat-reports.json"]));
  const transitions = JSON.parse(strFromU8(archive["vat-report-transitions.json"]));
  const artifacts = JSON.parse(strFromU8(archive["vat-report-artifacts.json"]));

  expect(reports).toEqual([
    expect.objectContaining({ period: "2026-10", result: expect.any(Object) }),
  ]);
  expect(transitions.map((entry: { action: string }) => entry.action)).toEqual([
    "vat_report.finalized",
    "reporting_period.unlocked",
  ]);
  expect(artifacts.map((artifact: { id: string; kind: string; resolvedDetails: object }) => ({
    id: artifact.id,
    kind: artifact.kind,
    resolvedDetails: artifact.resolvedDetails,
  }))).toEqual(expect.arrayContaining([
    { id: draft.value.artifactId, kind: "draft", resolvedDetails: expect.any(Object) },
    { id: final.value.artifactId, kind: "final", resolvedDetails: expect.any(Object) },
  ]));
  expect(archive[`vat-report-artifacts/${draft.value.artifactId}/${draft.value.fileName}`])
    .toEqual(draft.value.bytes);
  expect(archive[`vat-report-artifacts/${final.value.artifactId}/${final.value.fileName}`])
    .toEqual(final.value.bytes);
});

it.each(["pdf", "xlsx"] as const)("preserves a new %s Source's first manual DUZP draft outside a frozen report while refusing later locked changes", async format => {
  const company = await preparedCompany("2026-09");
  const user = await companyMember(company);
  const period = { companyId: company.companyId, period: "2026-09" };
  expect(await finalizeVatReport(company.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
  const final = await exportFinalVatReport(company.client, { ...period, format: "dphdp3", details: exportDetails });
  if (!final.ok) throw new Error(final.error);
  const snapshot = await getVatReport(user.client, period.companyId, period.period);
  expect(snapshot?.documents).toEqual([]);
  const original = format === "pdf" ? fixtureFile("two-invoices.pdf") : multiSheetWorkbookFile("xlsx");
  const uploaded = await uploadSourceFile(user.client, { async send() {} }, { companyId: period.companyId, fileName: `late.${format}`, bytes: original });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const ranges = format === "pdf" ? [{ firstPage: 1, lastPage: 2 }] : [{ sheetName: "Issued", firstRow: 2, lastRow: 3 }];
  const defined = await defineSourceDocuments(user.client, { companyId: period.companyId, sourceFileId: uploaded.value.id, ranges });
  if (!defined.ok) throw new Error(defined.error);
  expect(defined.value.documentIds).toHaveLength(1);
  const input = { companyId: period.companyId, documentId: defined.value.documentIds[0] };
  expect(await listExtractionVersions(user.client, input.companyId, input.documentId)).toEqual([]);
  const payload = { ...SAMPLE_EXTRACTION, taxPointDate: "2026-09-15" };
  expect(await correctDocument(user.client, { ...input, basedOnVersion: 0, payload })).toEqual({ ok: true, value: { version: 1 } });
  const versions = await listExtractionVersions(user.client, input.companyId, input.documentId);
  expect(versions.map(version => [version.version, version.author.kind, version.payload.taxPointDate])).toEqual([[1, "user", "2026-09-15"]]);
  expect(versions[0].author).toEqual({ kind: "user", userId: user.userId });
  expect((await getDocument(user.client, input.companyId, input.documentId))?.status).toBe("needs_review");
  expect((await listCompanyDocuments(user.client, input.companyId)).find(document => document.id === input.documentId))
    .toMatchObject({ status: "needs_review", reportingPeriod: "2026-09", claimedReportingPeriod: null });
  expect(await correctDocument(user.client, { ...input, basedOnVersion: 1, payload })).toEqual({ ok: false, error: "period_locked" });
  expect(await approveDocument(user.client, { ...input, version: 1 })).toEqual({ ok: false, error: "period_locked" });
  expect(await rejectDocument(user.client, { ...input, reason: "Not business evidence" })).toEqual({ ok: false, error: "period_locked" });
  expect(await getVatReport(user.client, period.companyId, period.period)).toEqual(snapshot);
  expect((await readVatReportArtifact(user.client, { companyId: period.companyId, artifactId: final.value.artifactId }))?.bytes).toEqual(final.value.bytes);
  const exported = await exportCompanyData(company.client, { async send() {} }, { companyId: period.companyId });
  if (!exported.ok) throw new Error(exported.error);
  const archive = unzipSync(exported.value.bytes);
  expect(archive[`vat-report-artifacts/${final.value.artifactId}/${final.value.fileName}`]).toEqual(final.value.bytes);
  expect(archive[`source-files/${uploaded.value.id}/late.${format}`]).toEqual(original);
  const archivedReport = JSON.parse(strFromU8(archive["vat-reports.json"]))
    .find((report: { period: string }) => report.period === "2026-09");
  expect(archivedReport).toMatchObject({ period: "2026-09", documents: [], result: snapshot!.result });
  expect(await listExtractionVersions(user.client, input.companyId, input.documentId)).toEqual(versions);
  expect(await unlockReportingPeriod(user.client, { ...period, confirmed: true, reason: "Review late evidence" })).toEqual({ ok: false, error: "forbidden" });
  expect(await unlockReportingPeriod(company.client, { ...period, confirmed: true, reason: "Review late evidence" })).toEqual({ ok: true, value: null });
  expect(await approveDocument(user.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
  expect((await readSourceFile(user.client, input.companyId, uploaded.value.id))?.bytes).toEqual(original);
});
