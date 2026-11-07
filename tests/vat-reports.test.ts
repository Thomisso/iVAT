import { setOctoberImportFixture } from "./support/claim-eligibility";
import { expect, it } from "vitest";
import { generateVatReport, getVatReport } from "@/application/vat-reports";
import {
  approveDocument,
  listDocuments,
  updateDocumentReporting,
  correctDocument,
  returnDocumentToReview,
} from "@/application/documents";
import {
  createCompanyIdentity,
  getCompany,
  updateCompany,
} from "@/application/companies";
import { listAuditEvents } from "@/application/audit";
import { uploadSourceFile } from "@/application/source-files";
import {
  administratorWithCompany,
  knownSupplierFixture,
  assignAiConfigurationFixture as enableAiProcessing,
  companyDetails,
  companyMember,
  companyWithManyReportDocuments,
} from "./support/fixtures";
import { provisionedUser } from "./support/clients";
import { fixtureFile } from "./support/files";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { testWorker } from "./support/worker";

async function companyWithReportDocuments() {
  const admin = await administratorWithCompany();
  await knownSupplierFixture(admin);
  const worker = testWorker();
  await enableAiProcessing(admin.client, worker.jobs, {
    companyId: admin.companyId,
    provider: worker.ai,
  });
  const file = await uploadSourceFile(admin.client, worker.jobs, {
    companyId: admin.companyId,
    fileName: "two-invoices.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  if (!file.ok) throw new Error(file.error);
  await setOctoberImportFixture(file.value.id);
  expect(await worker.runJobs()).toEqual([]);
  const documents = await listDocuments(
    admin.client,
    admin.companyId,
    file.value.id,
  );
  await approveDocument(admin.client, {
    companyId: admin.companyId,
    documentId: documents[0].id,
    version: 1,
  });
  return { ...admin, documents };
}
it("a Company User generates a stored draft, with exclusions, source versions and an audit event, and regenerates it", async () => {
  const company = await companyWithReportDocuments();
  const member = await companyMember(company);
  const input = { companyId: company.companyId, period: "2026-10" };
  const result = await generateVatReport(member.client, input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  const report = await getVatReport(
    member.client,
    input.companyId,
    input.period,
  );
  expect(report).toEqual(
    expect.objectContaining({ id: result.value.id, period: "2026-10" }),
  );
  expect(report!.result.vatReturn.find((entry) => entry.line === "40")).toEqual(
    {
      line: "40",
      netAmount: "1000.00",
      vatAmount: "210.00",
      documentIds: [company.documents[0].id],
    },
  );
  expect(report!.documents).toHaveLength(2);
  expect(report!.documents[0].extractionVersionId).toEqual(expect.any(String));
  expect(report!.result.excludedDocuments).toEqual([
    { documentId: company.documents[1].id, reason: "not_approved" },
  ]);
  await approveDocument(company.client, {
    companyId: company.companyId,
    documentId: company.documents[1].id,
    version: 1,
  });
  expect(
    (await getVatReport(member.client, input.companyId, input.period))!.result
      .totals.inputVat,
  ).toBe("210.00");
  expect(await generateVatReport(member.client, input)).toEqual({
    ok: true,
    value: { id: result.value.id },
  });
  expect(
    (await getVatReport(member.client, input.companyId, input.period))!.result
      .totals.inputVat,
  ).toBe("420.00");
  const events = await listAuditEvents(company.client, company.organizationId);
  expect(
    events.filter((e) => e.action === "vat_report.generated"),
  ).toHaveLength(2);
});

it("includes a late-imported incoming Document in its Tax Point Date's period, or in its later Deferred Claim", async () => {
  const admin = await administratorWithCompany();
  await knownSupplierFixture(admin);
  const worker = testWorker(fakeAiProvider({
    extract: () => ({ ...SAMPLE_EXTRACTION, direction: "incoming", taxPointDate: "2026-09-15", issueDate: "2026-09-15" }),
  }));
  await enableAiProcessing(admin.client, worker.jobs, {
    companyId: admin.companyId,
    provider: worker.ai,
  });
  const file = await uploadSourceFile(admin.client, worker.jobs, {
    companyId: admin.companyId,
    fileName: "receipt.png",
    bytes: fixtureFile("receipt.png"),
  });
  if (!file.ok) throw new Error(file.error);
  await setOctoberImportFixture(file.value.id);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(admin.client, admin.companyId, file.value.id);
  expect(await correctDocument(admin.client, { companyId: admin.companyId, documentId: document.id, basedOnVersion: 1,
    payload: { ...SAMPLE_EXTRACTION, taxPointDate: "2026-09-15", issueDate: "2026-09-15", claimEligibility: { period: "2026-09", origin: "user", confirmed: true } },
  })).toMatchObject({ ok: true, value: { version: 2 } });
  expect(await approveDocument(admin.client, {
    companyId: admin.companyId,
    documentId: document.id,
    version: 2,
  })).toEqual({ ok: true, value: null });
  const inputVatDocuments = async (period: string) => {
    const generated = await generateVatReport(admin.client, { companyId: admin.companyId, period });
    if (!generated.ok) throw new Error(generated.error);
    return (await getVatReport(admin.client, admin.companyId, period))!.result
      .vatReturn.find((line) => line.line === "40")!.documentIds;
  };

  expect(await inputVatDocuments("2026-09")).toEqual([document.id]);
  expect(await inputVatDocuments("2026-10")).toEqual([]);
  expect(await returnDocumentToReview(admin.client, { companyId: admin.companyId, documentId: document.id })).toEqual({ ok: true, value: null });
  expect(
    await updateDocumentReporting(admin.client, {
      companyId: admin.companyId,
      documentId: document.id,
      claimedReportingPeriod: "2026-12",
    }),
  ).toEqual({ ok: true, value: null });
  expect(await approveDocument(admin.client, { companyId: admin.companyId, documentId: document.id, version: 2 })).toEqual({ ok: true, value: null });
  expect(await inputVatDocuments("2026-09")).toEqual([]);
  expect(await inputVatDocuments("2026-12")).toEqual([document.id]);
});

it("generates quarterly Reporting Periods when the Company's Reporting Year becomes quarterly", async () => {
  const company = await companyWithReportDocuments();
  const details = await getCompany(company.client, company.companyId);
  if (!details) throw new Error("Company not found");
  expect(
    await updateCompany(company.client, {
      companyId: company.companyId,
      ...details,
      filingFrequency: "quarterly",
      reportingYear: 2026,
    }),
  ).toEqual({ ok: true, value: null });

  expect(await returnDocumentToReview(company.client, { companyId: company.companyId, documentId: company.documents[0].id })).toEqual({ ok: true, value: null });
  expect(await correctDocument(company.client, { companyId: company.companyId, documentId: company.documents[0].id, basedOnVersion: 1,
    payload: { ...SAMPLE_EXTRACTION, claimEligibility: { period: "2026-Q4", origin: "user", confirmed: true } },
  })).toMatchObject({ ok: true, value: { version: 2 } });
  expect(await approveDocument(company.client, { companyId: company.companyId, documentId: company.documents[0].id, version: 2 })).toEqual({ ok: true, value: null });

  expect(
    await generateVatReport(company.client, {
      companyId: company.companyId,
      period: "2026-10",
    }),
  ).toEqual({ ok: false, error: "invalid_reporting_period" });
  expect(
    await generateVatReport(company.client, {
      companyId: company.companyId,
      period: "2026-Q4",
    }),
  ).toEqual({ ok: true, value: { id: expect.any(String) } });
  expect(
    (await getVatReport(company.client, company.companyId, "2026-Q4"))!.result
      .vatReturn.find((line) => line.line === "40")!.documentIds,
  ).toEqual([company.documents[0].id]);
});
it("isolates stored reports and generation from another Organization, including direct database access", async () => {
  const a = await companyWithReportDocuments();
  const b = await provisionedUser();
  const input = { companyId: a.companyId, period: "2026-10" };
  const result = await generateVatReport(a.client, input);
  expect(result.ok).toBe(true);
  expect(
    await getVatReport(b.client, input.companyId, input.period),
  ).toBeNull();
  expect(await generateVatReport(b.client, input)).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(
    (
      await b.client
        .from("vat_report")
        .select("id")
        .eq("company_id", a.companyId)
    ).data,
  ).toEqual([]);
  expect(
    (
      await b.client
        .from("vat_report_document")
        .select("id")
        .eq("company_id", a.companyId)
    ).data,
  ).toEqual([]);
  const direct = await b.client.rpc("save_vat_report", {
    target_company_id: a.companyId,
    target_period: "2026-10",
    expected_documents: [],
    computed_result: {},
  });
  expect(direct.error?.code).toBe("42501");
});
it("refuses invalid months without changing a report", async () => {
  const a = await administratorWithCompany();
  expect(
    await generateVatReport(a.client, {
      companyId: a.companyId,
      period: "2026-13",
    }),
  ).toEqual({ ok: false, error: "invalid_reporting_period" });
});

it("refuses generation until required Company onboarding is complete", async () => {
  const user = await provisionedUser();
  const created = await createCompanyIdentity(user.client, {
    organizationId: user.organizationId,
    ...companyDetails(),
  });
  if (!created.ok) throw new Error(created.error);

  expect(await generateVatReport(user.client, {
    companyId: created.value.id,
    period: "2026-10",
  })).toEqual({ ok: false, error: "company_setup_incomplete" });
});

it("stores canonical structured Company identity in an immutable VAT Report snapshot", async () => {
  const company = await administratorWithCompany();
  expect((await generateVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  })).ok).toBe(true);
  const before = (await getVatReport(company.client, company.companyId, "2026-10"))!;
  expect(before.result.company).toEqual(expect.objectContaining({
    firstName: null,
    lastName: null,
    streetName: "Vinohradská",
    houseNumber: "12",
    orientationNumber: null,
  }));
  const identity = await getCompany(company.client, company.companyId);
  if (!identity) throw new Error("Company not found");
  await updateCompany(company.client, {
    ...identity,
    companyId: company.companyId,
    streetName: "Nová ulice",
    houseNumber: "99",
    filingFrequency: "monthly",
    reportingYear: 2026,
  });

  expect((await getVatReport(company.client, company.companyId, "2026-10"))!.result.company)
    .toEqual(before.result.company);
});
it("refuses a stale source snapshot and direct writes to a stored report", async () => {
  const a = await companyWithReportDocuments();
  await generateVatReport(a.client, {
    companyId: a.companyId,
    period: "2026-10",
  });
  const report = (await getVatReport(a.client, a.companyId, "2026-10"))!;
  await approveDocument(a.client, {
    companyId: a.companyId,
    documentId: a.documents[1].id,
    version: 1,
  });
  const stale = await a.client.rpc("save_vat_report", {
    target_company_id: a.companyId,
    target_period: "2026-10",
    expected_documents:
      report.documents as unknown as import("@/lib/database.types").Json,
    computed_result:
      report.result as unknown as import("@/lib/database.types").Json,
  });
  expect(stale.error?.hint).toBe("stale_report");
  const update = await a.client
    .from("vat_report")
    .update({ result: {} })
    .eq("id", report.id);
  expect(update.error?.code).toBe("42501");
  expect(
    (await getVatReport(a.client, a.companyId, "2026-10"))!.result.totals
      .inputVat,
  ).toBe("210.00");
});

it("a malformed AI date cannot block generation from valid Documents", async () => {
  const a = await administratorWithCompany();
  let i = 0;
  const worker = testWorker(
    fakeAiProvider({
      extract: () => ({
        ...SAMPLE_EXTRACTION,
        taxPointDate: i++ === 0 ? "2026-10" : "2026-10-01",
      }),
    }),
  );
  await enableAiProcessing(a.client, worker.jobs, {
    companyId: a.companyId,
    provider: worker.ai,
  });
  await uploadSourceFile(a.client, worker.jobs, {
    companyId: a.companyId,
    fileName: "two-invoices.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  expect(await worker.runJobs()).toEqual([]);
  expect(
    (
      await generateVatReport(a.client, {
        companyId: a.companyId,
        period: "2026-10",
      })
    ).ok,
  ).toBe(true);
});

it("generates from more Documents than the API row cap without losing exclusions", async () => {
  const a = await companyWithManyReportDocuments(1001);
  const generated = await generateVatReport(a.client, {
    companyId: a.companyId,
    period: "2026-10",
  });
  expect(generated.ok).toBe(true);
  const report = (await getVatReport(a.client, a.companyId, "2026-10"))!;
  expect(report.documents).toHaveLength(1001);
  expect(report.result.excludedDocuments).toHaveLength(1001);
}, 60000);
