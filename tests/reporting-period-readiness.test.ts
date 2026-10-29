import { expect, it } from "vitest";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import {
  approveDocument,
  listCompanyDocuments,
  listDocuments,
  rejectDocument,
} from "@/application/documents";
import { getCompany, updateCompany } from "@/application/companies";
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

it("lists monthly and quarterly Reporting Periods and advances the oldest unfinished period", async () => {
  const company = await administratorWithCompany();
  expect(
    (await listReportingPeriods(company.client, company.companyId, "2026-04-30"))
      .map(({ period, oldestUnfinished }) => ({ period, oldestUnfinished })),
  ).toEqual([
    { period: "2026-01", oldestUnfinished: true },
    { period: "2026-02", oldestUnfinished: false },
    { period: "2026-03", oldestUnfinished: false },
    { period: "2026-04", oldestUnfinished: false },
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
    (await listReportingPeriods(company.client, company.companyId, "2026-04-30"))
      .find((period) => period.oldestUnfinished)?.period,
  ).toBe("2026-02");

  const details = await getCompany(company.client, company.companyId);
  if (!details) throw new Error("Company not found");
  expect(await updateCompany(company.client, {
    ...details,
    companyId: company.companyId,
    filingFrequency: "quarterly",
    filingFrequencyEffectiveFrom: "2026-04-01",
  })).toEqual({ ok: true, value: null });
  expect(
    (await listReportingPeriods(company.client, company.companyId, "2026-10-31"))
      .map((period) => period.period),
  ).toEqual(["2026-01", "2026-02", "2026-03", "2026-Q2", "2026-Q3", "2026-Q4"]);
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
  expect(await rejectDocument(company.client, {
    companyId: company.companyId,
    documentId: rejectable.id,
  })).toEqual({ ok: true, value: null });
  const waiting = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "waiting.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  if (!waiting.ok) throw new Error(waiting.error);
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
  await worker.runNextJob();
  const stale = await getReportingPeriodReadiness(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  });
  expect(stale.ok && stale.value.snapshot?.freshness).toBe("stale");
  expect(stale.ok && stale.value.groups.processing).toHaveLength(2);
  expect(await getVatReport(company.client, company.companyId, "2026-10")).toEqual(saved);
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
  expect(await worker.runJobs()).toEqual([]);
  const documents = await listDocuments(company.client, company.companyId, uploaded.value.id);
  for (const document of documents) {
    expect(await rejectDocument(company.client, {
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
}, 60_000);
