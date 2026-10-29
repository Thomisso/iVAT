import { describe, expect, it } from "vitest";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { listCompanyDocuments } from "@/application/documents";
import { uploadSourceFile } from "@/application/source-files";
import {
  createCompany,
  createCompanyIdentity,
  getCompanySetupChecklist,
  listCompanyReportingYears,
  setCurrentReportingYear,
} from "@/application/companies";
import { listAuditEvents } from "@/application/audit";
import { listReportingPeriods } from "@/application/reporting-period-readiness";
import { generateVatReport } from "@/application/vat-reports";
import { Client as DatabaseClient } from "pg";
import { inject } from "vitest";
import { signedUpUser } from "./support/clients";
import { fixtureFile } from "./support/files";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
  companyDetails,
  companyMember,
} from "./support/fixtures";
import { testWorker } from "./support/worker";

/** An outgoing Document per Tax Point Date, processed for the given Company. */
async function outgoingDocuments(
  company: Awaited<ReturnType<typeof administratorWithCompany>>,
  taxPointDates: string[],
) {
  const pending = [...taxPointDates];
  const worker = testWorker(fakeAiProvider({
    extract: () => {
      const taxPointDate = pending.shift()!;
      return {
        ...SAMPLE_EXTRACTION,
        documentNumber: `FV-${taxPointDate}`,
        direction: "outgoing",
        issueDate: taxPointDate,
        taxPointDate,
        dueDate: taxPointDate,
        customer: SAMPLE_EXTRACTION.supplier,
        supplier: { ...SAMPLE_EXTRACTION.customer },
      };
    },
  }));
  await enableAiProcessing(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  for (const date of taxPointDates) {
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: `${date}.png`,
      bytes: fixtureFile("receipt.png"),
      preselectedDirection: "outgoing",
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
  }
  await worker.runJobs();
  const documents = await listCompanyDocuments(company.client, company.companyId);
  return Object.fromEntries(documents.map((document) => [document.taxPointDate, document.reportingPeriod]));
}

describe("Reporting Years from onboarding", () => {
  it("creates the current Reporting Year with the chosen frequency and lists only its periods", async () => {
    const { client, organizationId } = await signedUpUser();
    const created = await createCompany(client, {
      organizationId,
      ...companyDetails({ filingFrequency: "quarterly", reportingYear: 2026 }),
    });
    if (!created.ok) throw new Error(created.error);

    expect(await listCompanyReportingYears(client, created.value.id)).toEqual([
      { year: 2026, frequency: "quarterly", firstMonth: 1 },
    ]);
    expect(await listReportingPeriods(client, created.value.id)).toEqual(
      ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"].map((period, index) => ({
        period,
        frequency: "quarterly",
        generatedAt: null,
        lockedAt: null,
        state: "unfinished",
        oldestUnfinished: index === 0,
      })),
    );
  });

  it("updates the current Reporting Year when the filing frequency step is saved again", async () => {
    const { client, organizationId } = await signedUpUser();
    const identity = await createCompanyIdentity(client, { organizationId, ...companyDetails() });
    if (!identity.ok) throw new Error(identity.error);
    expect(await listReportingPeriods(client, identity.value.id)).toEqual([]);

    for (const filingFrequency of ["monthly", "quarterly"] as const) {
      expect(await setCurrentReportingYear(client, {
        companyId: identity.value.id,
        filingFrequency,
        year: 2026,
      })).toEqual({ ok: true, value: null });
    }

    expect(await listCompanyReportingYears(client, identity.value.id)).toEqual([
      { year: 2026, frequency: "quarterly", firstMonth: 1 },
    ]);
    expect((await getCompanySetupChecklist(client, identity.value.id))[1]).toEqual({
      step: "filing_frequency", state: "completed",
    });
  });
});

describe("Reporting Period lookup", () => {
  it("assigns a date to its Reporting Year's period and leaves dates outside generated years without one", async () => {
    const company = await administratorWithCompany();

    expect(await outgoingDocuments(company, ["2026-03-15", "2025-12-31", "2027-01-01"])).toEqual({
      "2026-03-15": "2026-03",
      "2025-12-31": null,
      "2027-01-01": null,
    });

    expect(await setCurrentReportingYear(company.client, {
      companyId: company.companyId,
      filingFrequency: "quarterly",
      year: 2025,
    })).toEqual({ ok: true, value: null });
    expect(Object.fromEntries((await listCompanyDocuments(company.client, company.companyId))
      .map((document) => [document.taxPointDate, document.reportingPeriod]))).toEqual({
      "2026-03-15": "2026-03",
      "2025-12-31": "2025-Q4",
      "2027-01-01": null,
    });
    expect((await listReportingPeriods(company.client, company.companyId)).map(({ period }) => period)).toEqual([
      "2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4",
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
      "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
    ]);
  });
});

describe("Reporting Year changes from onboarding", () => {
  it("keeps the frequency of a year whose period has a VAT Report and audits accepted changes", async () => {
    const company = await administratorWithCompany();
    expect((await generateVatReport(company.client, {
      companyId: company.companyId,
      period: "2026-02",
    })).ok).toBe(true);

    expect(await setCurrentReportingYear(company.client, {
      companyId: company.companyId,
      filingFrequency: "quarterly",
      year: 2026,
    })).toEqual({ ok: false, error: "reporting_year_in_use" });
    expect(await setCurrentReportingYear(company.client, {
      companyId: company.companyId,
      filingFrequency: "quarterly",
      year: 2027,
    })).toEqual({ ok: true, value: null });
    expect(await setCurrentReportingYear(company.client, {
      companyId: company.companyId,
      filingFrequency: "monthly",
      year: 2027,
    })).toEqual({ ok: true, value: null });

    expect(await listCompanyReportingYears(company.client, company.companyId)).toEqual([
      { year: 2026, frequency: "monthly", firstMonth: 1 },
      { year: 2027, frequency: "monthly", firstMonth: 1 },
    ]);
    expect((await listAuditEvents(company.client, company.organizationId))
      .filter((event) => event.action.startsWith("reporting_year."))
      .map(({ action, actorUserId, companyId, payload }) => ({ action, actorUserId, companyId, payload })))
      .toEqual(expect.arrayContaining([
        {
          action: "reporting_year.generated",
          actorUserId: company.userId,
          companyId: company.companyId,
          payload: { year: 2026, frequency: "monthly", first_month: 1 },
        },
        {
          action: "reporting_year.generated",
          actorUserId: company.userId,
          companyId: company.companyId,
          payload: { year: 2027, frequency: "quarterly", first_month: 1 },
        },
        {
          action: "reporting_year.changed",
          actorUserId: company.userId,
          companyId: company.companyId,
          payload: { year: 2027, frequency: { from: "quarterly", to: "monthly" } },
        },
      ]));
  });

  it("lets only Administrators write Reporting Years and hides them from other Organizations", async () => {
    const company = await administratorWithCompany();
    const user = await companyMember(company, "user");
    const outsider = await signedUpUser("Other Organization");

    expect(await setCurrentReportingYear(user.client, {
      companyId: company.companyId,
      filingFrequency: "quarterly",
      year: 2027,
    })).toEqual({ ok: false, error: "forbidden" });
    expect(await listCompanyReportingYears(user.client, company.companyId)).toEqual([
      { year: 2026, frequency: "monthly", firstMonth: 1 },
    ]);
    expect(await listCompanyReportingYears(outsider.client, company.companyId)).toEqual([]);

    const forged = await outsider.client.from("reporting_year").insert({
      company_id: company.companyId,
      organization_id: company.organizationId,
      year: 2027,
      frequency: "quarterly",
    });
    expect(forged.error?.code).toBe("42501");
    const changed = await user.client.from("reporting_year")
      .update({ frequency: "quarterly" })
      .eq("company_id", company.companyId)
      .select();
    expect(changed.error?.code).toBe("42501");
    expect(await listCompanyReportingYears(company.client, company.companyId)).toEqual([
      { year: 2026, frequency: "monthly", firstMonth: 1 },
    ]);
  });
});

describe("Reporting Year migration", () => {
  /** The rule the migration applied to every existing Company's filing-frequency history. */
  async function migrated(history: { frequency: string; effectiveFrom: string }[], throughYear: number) {
    const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
    await database.connect();
    try {
      const { rows } = await database.query<{ year: number; frequency: string; first_month: number }>(
        "select * from private.reporting_years_from_frequency_history($1::jsonb, $2)",
        [JSON.stringify(history), throughYear],
      );
      return rows.map((row) => ({ year: row.year, frequency: row.frequency, firstMonth: row.first_month }));
    } finally {
      await database.end();
    }
  }

  it("creates one year per calendar year through the current year with the frequency in force on 1 January", async () => {
    expect(await migrated([
      { frequency: "monthly", effectiveFrom: "2024-03-01" },
      { frequency: "quarterly", effectiveFrom: "2025-01-01" },
      { frequency: "monthly", effectiveFrom: "2026-01-01" },
    ], 2026)).toEqual([
      { year: 2024, frequency: "monthly", firstMonth: 3 },
      { year: 2025, frequency: "quarterly", firstMonth: 1 },
      { year: 2026, frequency: "monthly", firstMonth: 1 },
    ]);
  });

  it("starts a quarterly first year on its quarter and continues an unchanged frequency", async () => {
    expect(await migrated([{ frequency: "quarterly", effectiveFrom: "2025-07-01" }], 2026)).toEqual([
      { year: 2025, frequency: "quarterly", firstMonth: 7 },
      { year: 2026, frequency: "quarterly", firstMonth: 1 },
    ]);
    expect(await migrated([{ frequency: "quarterly", effectiveFrom: "2026-05-14" }], 2026)).toEqual([
      { year: 2026, frequency: "quarterly", firstMonth: 4 },
    ]);
    expect(await migrated([], 2026)).toEqual([]);
  });
});
