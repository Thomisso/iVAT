import { reportingWorkbookCopy } from "./support/reporting-workbook-copy";
import { expect, inject, it } from "vitest";
import { Client as DatabaseClient } from "pg";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import {
  approveDocument,
  listCompanyDocuments,
  listDocuments,
  listExtractionVersions,
  rejectDocument,
} from "@/application/documents";
import { setCurrentReportingYear } from "@/application/companies";
import {
  getReportingPeriodReadiness,
  listReportingPeriods,
  readinessDocumentCounts,
  readinessDocumentIds,
} from "@/application/reporting-period-readiness";
import { getDocumentQueue } from "@/application/document-queue";
import {
  finalizeVatReport,
  generateVatReport,
  getVatReport,
} from "@/application/vat-reports";
import { uploadSourceFile } from "@/application/source-files";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
  companyWithManyReportDocuments,
} from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { exportReportingPeriodWorkbook } from "@/application/reporting-period-excel";
import * as XLSX from "xlsx";

/** Keeps unassigned work in the synthetic October Reporting Period. */
async function setOctoberImportDateFixture(sourceFileId: string) {
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("update public.source_file set uploaded_at = '2026-10-15T10:00:00Z' where id = $1", [sourceFileId]);
  } finally { await database.end(); }
}

it("lists the generated Reporting Periods and advances the oldest unfinished period", async () => {
  const company = await administratorWithCompany();
  expect(
    (await listReportingPeriods(company.client, company.companyId))
      .slice(0, 3)
      .map(({ period, oldestUnfinished }) => ({ period, oldestUnfinished })),
  ).toEqual([
    { period: "2026-01", oldestUnfinished: true },
    { period: "2026-02", oldestUnfinished: false },
    { period: "2026-03", oldestUnfinished: false },
  ]);

  expect((await generateVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-01",
  })).ok).toBe(true);
  expect(await finalizeVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-01",
    confirmed: true,
  })).toEqual({ ok: true, value: null });
  expect(
    (await listReportingPeriods(company.client, company.companyId))
      .find((period) => period.oldestUnfinished)?.period,
  ).toBe("2026-02");

  expect(await setCurrentReportingYear(company.client, {
    companyId: company.companyId,
    filingFrequency: "quarterly",
    year: 2027,
  })).toEqual({ ok: true, value: null });
  expect(
    (await listReportingPeriods(company.client, company.companyId))
      .map((period) => period.period)
      .slice(10),
  ).toEqual(["2026-11", "2026-12", "2027-Q1", "2027-Q2", "2027-Q3", "2027-Q4"]);
});

async function companyWithReadinessStates() {
  const company = await administratorWithCompany();
  let extraction = 0;
  const worker = testWorker(fakeAiProvider({
    extract: () => {
      extraction += 1;
      if (extraction === 1) {
        return { ...SAMPLE_EXTRACTION, confidence: { documentNumber: 0.4 } };
      }
      if (extraction === 2) return SAMPLE_EXTRACTION;
      if (extraction === 3) {
        return {
          ...SAMPLE_EXTRACTION,
          direction: null,
          customer: { ...SAMPLE_EXTRACTION.customer, ico: null, vatId: null },
          taxPointDate: null,
          currency: null,
          rateBreakdown: [],
          proposedVatRegime: "other",
        };
      }
      throw new Error("terminal extraction failure");
    },
  }));
  await enableAiProcessing(company.client, worker.jobs, {
    companyId: company.companyId,
    provider: worker.ai,
  });
  const sourceFileIds: string[] = [];
  for (const fileName of ["first.pdf", "second.pdf"]) {
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName,
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await setOctoberImportDateFixture(uploaded.value.id);
    sourceFileIds.push(uploaded.value.id);
  }
  expect(await worker.runJobs()).toHaveLength(1);
  const documents = (await Promise.all(
    sourceFileIds.map((id) => listDocuments(company.client, company.companyId, id)),
  )).flat();
  const warningDocument = documents.find((document) => document.status === "needs_review" && document.id);
  if (!warningDocument) throw new Error("Warning Document not found");
  expect(await approveDocument(company.client, {
    companyId: company.companyId,
    documentId: warningDocument.id,
    version: 1,
  })).toEqual({ ok: true, value: null });
  const rejectable = documents.find((document) =>
    document.status === "needs_review" && document.id !== warningDocument.id,
  );
  if (!rejectable) throw new Error("Rejectable Document not found");
  expect(await rejectDocument(company.client, { reason: "Not a business Document",
    companyId: company.companyId,
    documentId: rejectable.id,
  })).toEqual({ ok: true, value: null });
  const waiting = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "waiting.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  if (!waiting.ok) throw new Error(waiting.error);
  await setOctoberImportDateFixture(waiting.value.id);
  await worker.runNextJob();
  return company;
}

it("returns blocker, warning and resolved Document groups without writing live data", async () => {
  const company = await companyWithReadinessStates();
  const before = await listCompanyDocuments(company.client, company.companyId);
  const readiness = await getReportingPeriodReadiness(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  });
  expect(readiness.ok).toBe(true);
  if (!readiness.ok) throw new Error(readiness.error);
  expect(readiness.value.groups.approved).toHaveLength(1);
  expect(readiness.value.groups.rejected).toHaveLength(1);
  expect(readiness.value.groups.needsReview).toHaveLength(1);
  expect(readiness.value.groups.failed).toHaveLength(1);
  expect(readiness.value.groups.processing).toHaveLength(2);
  expect(readiness.value.blockers.map((finding) => finding.code)).toEqual(
    expect.arrayContaining([
      "processing",
      "failed",
      "needs_review",
      "missing_direction",
      "missing_tax_point_date",
      "missing_rate",
      "missing_currency",
    ]),
  );
  expect(readiness.value.warnings.map((finding) => finding.code)).toEqual(
    expect.arrayContaining(["warning_finding"]),
  );
  expect(readiness.value.warnings).not.toContainEqual(
    expect.objectContaining({ documentId: readiness.value.groups.rejected[0] }),
  );
  expect(readinessDocumentCounts(readiness.value)).toEqual({
    blockers: 4,
    warnings: 1,
    rejected: 1,
  });
  expect(readiness.value.blockers).not.toContainEqual(
    expect.objectContaining({ code: "warning_finding" }),
  );
  expect(readiness.value.snapshot).toBeNull();
  expect(await getVatReport(company.client, company.companyId, "2026-10")).toBeNull();
  expect(await listCompanyDocuments(company.client, company.companyId)).toEqual(before);

  expect((await generateVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  })).ok).toBe(true);
  expect((await getVatReport(company.client, company.companyId, "2026-10"))?.finalization).toEqual({
    blockerCount: 4,
    warningCount: 1,
    rejectedDocumentCount: 1,
  });
  const savedReadiness = await getReportingPeriodReadiness(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  });
  expect(savedReadiness.ok && savedReadiness.value.snapshot?.freshness).toBe("current");
});

it("resolves readiness queue links to the unique affected Documents", async () => {
  const company = await companyWithReadinessStates();
  const readiness = await getReportingPeriodReadiness(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  });
  if (!readiness.ok) throw new Error(readiness.error);

  for (const filter of ["blockers", "warnings", "rejected"] as const) {
    const queue = await getDocumentQueue(company.client, company.companyId, {
      view: "all",
      readiness: filter,
      reportingPeriod: "2026-10",
    });
    expect(queue.documents.map((document) => document.id).toSorted()).toEqual(
      readinessDocumentIds(readiness.value, filter).toSorted(),
    );
  }
});

it("reports a saved source snapshot as current, then stale after a relevant unassigned Document arrives", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker();
  await enableAiProcessing(company.client, worker.jobs, {
    companyId: company.companyId,
    provider: worker.ai,
  });
  const uploaded = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "snapshot.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportDateFixture(uploaded.value.id);
  expect(await worker.runJobs()).toEqual([]);
  const documents = await listDocuments(company.client, company.companyId, uploaded.value.id);
  expect(await approveDocument(company.client, {
    companyId: company.companyId,
    documentId: documents[0].id,
    version: 1,
  })).toEqual({ ok: true, value: null });
  expect((await generateVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  })).ok).toBe(true);
  const saved = await getVatReport(company.client, company.companyId, "2026-10");
  const current = await getReportingPeriodReadiness(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  });
  expect(current.ok && current.value.snapshot).toEqual(expect.objectContaining({
    reportId: saved?.id,
    generatedAt: saved?.generatedAt,
    freshness: "current",
  }));

  const laterUpload = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "later.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  if (!laterUpload.ok) throw new Error(laterUpload.error);
  await setOctoberImportDateFixture(laterUpload.value.id);
  await worker.runNextJob();
  const stale = await getReportingPeriodReadiness(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  });
  expect(stale.ok && stale.value.snapshot?.freshness).toBe("stale");
  expect(stale.ok && stale.value.groups.processing).toHaveLength(2);
  expect(await getVatReport(company.client, company.companyId, "2026-10")).toEqual(saved);
});

it("keeps unassigned Documents in their own Import Date period without changing recorded Versions", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker(fakeAiProvider({ extract: () => ({ ...SAMPLE_EXTRACTION, taxPointDate: null }) }));
  await enableAiProcessing(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const documents: { id: string; period: string }[] = [];
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    for (const [period, importedAt] of [["2026-10", "2026-10-15T10:00:00Z"], ["2026-11", "2026-11-01T10:00:00Z"]]) {
      const uploaded = await uploadSourceFile(company.client, worker.jobs, {
        companyId: company.companyId, fileName: `unassigned-${period}.png`, bytes: fixtureFile("receipt.png"),
      });
      if (!uploaded.ok) throw new Error(uploaded.error);
      await database.query("update public.source_file set uploaded_at = $2::timestamptz where id = $1", [uploaded.value.id, importedAt]);
      expect(await worker.runJobs()).toEqual([]);
      const [document] = await listDocuments(company.client, company.companyId, uploaded.value.id);
      expect(document.importDate).toBe(importedAt.slice(0, 10));
      documents.push({ id: document.id, period });
    }
  } finally { await database.end(); }
  const versions = await Promise.all(documents.map(document => listExtractionVersions(company.client, company.companyId, document.id)));
  for (const document of documents) {
    const readiness = await getReportingPeriodReadiness(company.client, { companyId: company.companyId, period: document.period });
    if (!readiness.ok) throw new Error(readiness.error);
    expect(readiness.value.groups.needsReview).toEqual([document.id]);
    expect(readiness.value.source.map(source => source.documentId)).toEqual([document.id]);
    expect(readiness.value.blockers).toContainEqual({ code: "missing_tax_point_date", documentId: document.id });
  }
  expect(await Promise.all(documents.map(document => listExtractionVersions(company.client, company.companyId, document.id)))).toEqual(versions);
});

it("keeps a new snapshot current when unassigned rejected Documents are resolved", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker(fakeAiProvider({
    extract: () => ({
      ...SAMPLE_EXTRACTION,
      direction: null,
      customer: { ...SAMPLE_EXTRACTION.customer, ico: null, vatId: null },
      taxPointDate: null,
    }),
  }));
  await enableAiProcessing(company.client, worker.jobs, {
    companyId: company.companyId,
    provider: worker.ai,
  });
  const uploaded = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "rejected-unassigned.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportDateFixture(uploaded.value.id);
  expect(await worker.runJobs()).toEqual([]);
  const documents = await listDocuments(company.client, company.companyId, uploaded.value.id);
  for (const document of documents) {
    expect(await rejectDocument(company.client, { reason: "Not a business Document",
      companyId: company.companyId,
      documentId: document.id,
    })).toEqual({ ok: true, value: null });
  }
  expect((await generateVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  })).ok).toBe(true);
  const readiness = await getReportingPeriodReadiness(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  });
  expect(readiness.ok).toBe(true);
  if (!readiness.ok) throw new Error(readiness.error);
  expect(readiness.value.ready).toBe(true);
  expect(readiness.value.groups.rejected).toHaveLength(2);
  expect(readiness.value.snapshot?.freshness).toBe("current");
});

it("counts every relevant Document beyond the API row cap", async () => {
  const company = await companyWithManyReportDocuments(1001);
  const readiness = await getReportingPeriodReadiness(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  });
  expect(readiness.ok).toBe(true);
  if (!readiness.ok) throw new Error(readiness.error);
  expect(readiness.value.groups.needsReview).toHaveLength(1001);
  expect(readiness.value.blockers.filter((finding) => finding.code === "needs_review"))
    .toHaveLength(1001);
  expect(Object.keys(readiness.value.documentReporting)).toHaveLength(1001);
  const exported = await exportReportingPeriodWorkbook(company.client, { companyId: company.companyId, period: "2026-10" }, reportingWorkbookCopy());
  if (!exported.ok) throw new Error(exported.error);
  const workbook = XLSX.read(exported.value.bytes, { type: "array" });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Attention);
  expect(new Set(rows.map(row => row["Document ID"])).size).toBe(1001);
  expect(rows.filter(row => row["VAT Return line"] === "40" && row["Control Statement section"] === "B.3" && row["Mapping status"] === "proposed")).toHaveLength(1001);
}, 60_000);
