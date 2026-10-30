import { describe, expect, it } from "vitest";
import { listCompanyReportingYears } from "@/application/companies";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { listAuditEvents } from "@/application/audit";
import { listCompanyDocuments } from "@/application/documents";
import { uploadSourceFile } from "@/application/source-files";
import {
  changeReportingYearFrequency,
  deleteReportingYear,
  generateReportingYears,
  missingReportingPeriodFinding,
  setFirstReportingMonth,
} from "@/application/reporting-years";
import { getReportingPeriodReadiness, listReportingPeriods } from "@/application/reporting-period-readiness";
import { currentReportingYear } from "@/application/reporting-periods";
import { finalizeVatReport, generateVatReport } from "@/application/vat-reports";
import { provisionedUser } from "./support/clients";
import { fixtureFile } from "./support/files";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
  companyMember,
} from "./support/fixtures";
import { testWorker } from "./support/worker";

describe("Generating Reporting Years", () => {
  it("generates a range with one frequency, skips existing years and reports both", async () => {
    const company = await administratorWithCompany();

    expect(await generateReportingYears(company.client, {
      companyId: company.companyId,
      fromYear: 2024,
      toYear: 2027,
      frequency: "quarterly",
    })).toEqual({ ok: true, value: { generated: [2024, 2025, 2027], skipped: [2026] } });

    expect(await listCompanyReportingYears(company.client, company.companyId)).toEqual([
      { year: 2024, frequency: "quarterly", firstMonth: 1 },
      { year: 2025, frequency: "quarterly", firstMonth: 1 },
      { year: 2026, frequency: "monthly", firstMonth: 1 },
      { year: 2027, frequency: "quarterly", firstMonth: 1 },
    ]);
    expect((await listAuditEvents(company.client, company.organizationId))
      .filter((event) => event.action === "reporting_year.generated")
      .map(({ actorUserId, companyId, payload }) => ({ actorUserId, companyId, payload })))
      .toEqual(expect.arrayContaining([2024, 2025, 2027].map((year) => ({
        actorUserId: company.userId,
        companyId: company.companyId,
        payload: { year, frequency: "quarterly", first_month: 1 },
      }))));
  });

  it("generates at most 20 years at once", async () => {
    const company = await administratorWithCompany();

    expect(await generateReportingYears(company.client, {
      companyId: company.companyId, fromYear: 2000, toYear: 2020, frequency: "monthly",
    })).toEqual({ ok: false, error: "too_many_reporting_years" });
    expect((await generateReportingYears(company.client, {
      companyId: company.companyId, fromYear: 2006, toYear: 2025, frequency: "monthly",
    })).ok).toBe(true);
  });

  it("keeps an existing year's first month when an earlier year is generated", async () => {
    const company = await administratorWithCompany();
    await setFirstReportingMonth(company.client, { companyId: company.companyId, year: 2026, firstMonth: 5 });

    expect(await generateReportingYears(company.client, {
      companyId: company.companyId, fromYear: 2025, toYear: 2026, frequency: "quarterly",
    })).toEqual({ ok: true, value: { generated: [2025], skipped: [2026] } });

    expect(await listCompanyReportingYears(company.client, company.companyId)).toEqual([
      { year: 2025, frequency: "quarterly", firstMonth: 1 },
      { year: 2026, frequency: "monthly", firstMonth: 5 },
    ]);
  });

});

describe("Changing a Reporting Year's frequency", () => {
  it("changes an unused year and refuses a year with a VAT Report or one that was never generated", async () => {
    const company = await administratorWithCompany();
    await generateReportingYears(company.client, {
      companyId: company.companyId, fromYear: 2027, toYear: 2027, frequency: "quarterly",
    });
    expect((await generateVatReport(company.client, { companyId: company.companyId, period: "2026-02" })).ok)
      .toBe(true);

    expect(await changeReportingYearFrequency(company.client, {
      companyId: company.companyId, year: 2027, frequency: "monthly",
    })).toEqual({ ok: true, value: null });
    expect(await changeReportingYearFrequency(company.client, {
      companyId: company.companyId, year: 2026, frequency: "quarterly",
    })).toEqual({ ok: false, error: "reporting_year_in_use" });
    expect(await changeReportingYearFrequency(company.client, {
      companyId: company.companyId, year: 2030, frequency: "quarterly",
    })).toEqual({ ok: false, error: "reporting_year_not_found" });

    expect(await listCompanyReportingYears(company.client, company.companyId)).toEqual([
      { year: 2026, frequency: "monthly", firstMonth: 1 },
      { year: 2027, frequency: "monthly", firstMonth: 1 },
    ]);
    expect((await listAuditEvents(company.client, company.organizationId))
      .filter((event) => event.action === "reporting_year.changed")
      .map(({ actorUserId, companyId, payload }) => ({ actorUserId, companyId, payload })))
      .toEqual([{
        actorUserId: company.userId,
        companyId: company.companyId,
        payload: { year: 2027, frequency: { from: "quarterly", to: "monthly" } },
      }]);
  });
});

describe("Deleting a Reporting Year", () => {
  it("deletes an unused year, refuses a year with a Period Lock and audits the deletion", async () => {
    const company = await administratorWithCompany();
    await generateReportingYears(company.client, {
      companyId: company.companyId, fromYear: 2025, toYear: 2025, frequency: "quarterly",
    });
    const locked = { companyId: company.companyId, period: "2026-03" };
    expect((await generateVatReport(company.client, locked)).ok).toBe(true);
    expect(await finalizeVatReport(company.client, { ...locked, confirmed: true })).toEqual({ ok: true, value: null });

    expect(await deleteReportingYear(company.client, { companyId: company.companyId, year: 2025 }))
      .toEqual({ ok: true, value: null });
    expect(await deleteReportingYear(company.client, { companyId: company.companyId, year: 2026 }))
      .toEqual({ ok: false, error: "reporting_year_in_use" });
    expect(await deleteReportingYear(company.client, { companyId: company.companyId, year: 2025 }))
      .toEqual({ ok: false, error: "reporting_year_not_found" });

    expect(await listCompanyReportingYears(company.client, company.companyId)).toEqual([
      { year: 2026, frequency: "monthly", firstMonth: 1 },
    ]);
    expect((await listAuditEvents(company.client, company.organizationId))
      .filter((event) => event.action === "reporting_year.deleted")
      .map(({ actorUserId, companyId, payload }) => ({ actorUserId, companyId, payload })))
      .toEqual([{
        actorUserId: company.userId,
        companyId: company.companyId,
        payload: { year: 2025, frequency: "quarterly", first_month: 1 },
      }]);
  });
});

describe("Starting the first Reporting Year later", () => {
  it("starts only the earliest year in a later month, on a quarter for a quarterly year", async () => {
    const company = await administratorWithCompany();
    await generateReportingYears(company.client, {
      companyId: company.companyId, fromYear: 2025, toYear: 2025, frequency: "quarterly",
    });

    expect(await setFirstReportingMonth(company.client, { companyId: company.companyId, year: 2026, firstMonth: 4 }))
      .toEqual({ ok: false, error: "not_first_reporting_year" });
    expect(await setFirstReportingMonth(company.client, { companyId: company.companyId, year: 2025, firstMonth: 5 }))
      .toEqual({ ok: false, error: "invalid_first_month" });
    expect(await setFirstReportingMonth(company.client, { companyId: company.companyId, year: 2025, firstMonth: 7 }))
      .toEqual({ ok: true, value: null });

    expect((await listReportingPeriods(company.client, company.companyId)).map(({ period }) => period).slice(0, 3))
      .toEqual(["2025-Q3", "2025-Q4", "2026-01"]);
    expect((await listAuditEvents(company.client, company.organizationId))
      .filter((event) => event.action === "reporting_year.changed")
      .map(({ payload }) => payload))
      .toEqual([{ year: 2025, first_month: { from: 1, to: 7 } }]);
  });
});

describe("Reporting Year management access", () => {
  it("refuses Users and other Organizations, including direct deletes", async () => {
    const company = await administratorWithCompany();
    const user = await companyMember(company, "user");
    const outsider = await provisionedUser("Other Organization");

    for (const { client } of [user, outsider]) {
      expect(await generateReportingYears(client, {
        companyId: company.companyId, fromYear: 2027, toYear: 2027, frequency: "monthly",
      })).toEqual({ ok: false, error: "forbidden" });
      expect(await changeReportingYearFrequency(client, {
        companyId: company.companyId, year: 2026, frequency: "quarterly",
      })).toEqual({ ok: false, error: "forbidden" });
      expect(await setFirstReportingMonth(client, { companyId: company.companyId, year: 2026, firstMonth: 3 }))
        .toEqual({ ok: false, error: "forbidden" });
      expect(await deleteReportingYear(client, { companyId: company.companyId, year: 2026 }))
        .toEqual({ ok: false, error: "forbidden" });
    }
    const deleted = await user.client.from("reporting_year").delete()
      .eq("company_id", company.companyId).select();
    expect(deleted.error?.code).toBe("42501");

    expect(await listCompanyReportingYears(company.client, company.companyId)).toEqual([
      { year: 2026, frequency: "monthly", firstMonth: 1 },
    ]);
  });
});

/** One processed outgoing Document with the given Tax Point Date. */
async function outgoingDocument(company: Awaited<ReturnType<typeof administratorWithCompany>>, taxPointDate: string) {
    const worker = testWorker(fakeAiProvider({
      extract: () => ({
        ...SAMPLE_EXTRACTION,
        direction: "outgoing",
        issueDate: taxPointDate,
        taxPointDate,
        dueDate: taxPointDate,
        customer: SAMPLE_EXTRACTION.supplier,
        supplier: { ...SAMPLE_EXTRACTION.customer },
      }),
    }));
    await enableAiProcessing(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: `${taxPointDate}.png`,
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await worker.runJobs();
    const [document] = await listCompanyDocuments(company.client, company.companyId);
    return document.id;
}

describe("Documents outside generated Reporting Years", () => {
  it("names the missing year until it is generated, then joins its period", async () => {
    const company = await administratorWithCompany();
    const documentId = await outgoingDocument(company, "2027-03-15");

    expect(await missingReportingPeriodFinding(company.client, company.companyId, documentId)).toEqual({
      field: "taxPointDate",
      severity: "error",
      code: "reporting_year_missing",
      params: { year: "2027" },
    });
    expect((await listCompanyDocuments(company.client, company.companyId))[0].reportingPeriod).toBeNull();

    await generateReportingYears(company.client, {
      companyId: company.companyId, fromYear: 2027, toYear: 2027, frequency: "monthly",
    });

    expect(await missingReportingPeriodFinding(company.client, company.companyId, documentId)).toBeNull();
    expect((await listCompanyDocuments(company.client, company.companyId))[0].reportingPeriod).toBe("2027-03");
  });

  it("names the first month when the Tax Point Date precedes the start of its year", async () => {
    const company = await administratorWithCompany();
    expect(await setFirstReportingMonth(company.client, { companyId: company.companyId, year: 2026, firstMonth: 5 }))
      .toEqual({ ok: true, value: null });
    const documentId = await outgoingDocument(company, "2026-03-15");

    expect(await missingReportingPeriodFinding(company.client, company.companyId, documentId)).toEqual({
      field: "taxPointDate",
      severity: "error",
      code: "tax_point_date_before_first_reporting_month",
      params: { year: "2026", month: "5" },
    });
  });
});

describe("Readiness with Documents outside generated Reporting Years", () => {
  it("blocks the period a Document without a Reporting Period falls back to, naming the missing year", async () => {
    const company = await administratorWithCompany();
    const year = currentReportingYear();
    await generateReportingYears(company.client, {
      companyId: company.companyId, fromYear: year, toYear: year, frequency: "monthly",
    });
    // Without a Reporting Period, a Document waits in the period it was imported in.
    const importPeriod = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Prague", year: "numeric", month: "2-digit",
    }).format(new Date());
    const documentId = await outgoingDocument(company, "2019-06-15");

    const readiness = await getReportingPeriodReadiness(company.client, {
      companyId: company.companyId, period: importPeriod,
    });
    if (!readiness.ok) throw new Error(readiness.error);

    expect(readiness.value.ready).toBe(false);
    expect(readiness.value.blockers).toContainEqual({
      code: "error_finding", documentId, findingCode: "reporting_year_missing",
    });
  });
});
