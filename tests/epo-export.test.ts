import { expect, it } from "vitest";
import { exportFinalVatReport, exportVatReport } from "@/application/epo-export";
import { finalizeVatReport, generateVatReport } from "@/application/vat-reports";
import { approveDocument, listCompanyDocuments } from "@/application/documents";
import { createCompany } from "@/application/companies";
import {
  getCompanyFilingDefaults,
  saveCompanyFilingDefaults,
} from "@/application/company-filing-defaults";
import { provisionedUser } from "./support/clients";
import {
  administratorWithCompany,
  companyMember,
  companyWithManyReportDocuments,
  companyDetails,
} from "./support/fixtures";

const details = {
  taxOffice: "451",
  territorialOffice: "2003",
  economicActivity: "621000",
  personType: "P",
  preparedOn: "2026-10-27",
  email: "qa@example.test",
  phone: "",
  signatoryFirstName: "Jana",
  signatoryLastName: "Nováková",
  signatoryCapacity: "jednatelka",
};

it("exports ordinary XML with independent future-date, unfinished-period and potentially-late advisories", async () => {
  const company = await administratorWithCompany();
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-03" });
  const result = await exportVatReport(company.client, {
    companyId: company.companyId, period: "2026-03", format: "dphdp3",
    details: { ...details, preparedOn: "2026-05-01" },
  }, () => new Date("2026-03-01T12:00:00Z"));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.timing).toEqual({
    today: "2026-03-01", periodEndsOn: "2026-03-31", filingKind: "ordinary",
    deadline: "2026-04-27",
    warnings: ["prepared_on_future", "reporting_period_unfinished", "potentially_late_filing"],
  });
  expect(result.value.xml).toContain('dapdph_forma="B"');
  expect(result.value.fileName).toBe("DRAFT_DPHDP3_2026-03.xml");
  expect(result.value.bytes.length).toBeGreaterThan(0);
});

// Official Financial Administration 2026 calendar: November outputs are due
// 28 December, after the Christmas holidays and Sunday 27 December.
it("keeps an ordinary filing on the holiday-adjusted deadline advisory-free", async () => {
  const company = await administratorWithCompany();
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-11" });
  const result = await exportVatReport(company.client, {
    companyId: company.companyId, period: "2026-11", format: "dphdp3",
    details: { ...details, preparedOn: "2026-12-28" },
  }, () => new Date("2026-12-28T12:00:00Z"));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.timing).toEqual({
    today: "2026-12-28", periodEndsOn: "2026-11-30", filingKind: "ordinary",
    deadline: "2026-12-28", warnings: [],
  });
});

it("moves an ordinary deadline past Good Friday, the weekend and Easter Monday", async () => {
  const user = await provisionedUser("Easter deadline");
  const company = await createCompany(user.client, { organizationId: user.organizationId, ...companyDetails({ reportingYear: 2016 }) });
  if (!company.ok) throw new Error(company.error);
  await generateVatReport(user.client, { companyId: company.value.id, period: "2016-02" });
  const result = await exportVatReport(user.client, {
    companyId: company.value.id, period: "2016-02", format: "dphdp3",
    details: { ...details, preparedOn: "2016-03-29" },
  }, () => new Date("2016-03-29T12:00:00Z"));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.timing.deadline).toBe("2016-03-29");
  expect(result.value.timing.warnings).toEqual([]);
});

it("does not invent a quarterly ordinary Control Statement deadline for a legal person", async () => {
  const user = await provisionedUser("Quarterly legal Company");
  const company = await createCompany(user.client, { organizationId: user.organizationId, ...companyDetails({ filingFrequency: "quarterly" }) });
  if (!company.ok) throw new Error(company.error);
  await generateVatReport(user.client, { companyId: company.value.id, period: "2026-Q3" });
  const result = await exportVatReport(user.client, {
    companyId: company.value.id, period: "2026-Q3", format: "dphkh1", details,
  }, () => new Date("2026-10-27T12:00:00Z"));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.timing).toEqual({
    today: "2026-10-27", periodEndsOn: "2026-09-30", filingKind: "ordinary",
    deadline: null, warnings: ["control_statement_monthly_required"],
  });
  expect(result.value.xml).toContain('khdph_forma="B"');
});

it.each([
  ["2026-03-31T21:59:00Z", "2026-03-31", ["reporting_period_unfinished"]],
  ["2026-03-31T22:00:00Z", "2026-04-01", []],
  ["2026-04-27T21:59:00Z", "2026-04-27", []],
  ["2026-04-27T22:00:00Z", "2026-04-28", ["potentially_late_filing"]],
])("evaluates ordinary timing at the Prague calendar boundary %s", async (instant, today, warnings) => {
  const company = await administratorWithCompany();
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-03" });
  const result = await exportVatReport(company.client, {
    companyId: company.companyId, period: "2026-03", format: "dphdp3",
    details: { ...details, preparedOn: "" },
  }, () => new Date(instant));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.timing).toEqual({ today, periodEndsOn: "2026-03-31", deadline: "2026-04-27", filingKind: "ordinary", warnings });
});

// The ordinary October 26 deadline for September/Q3 is independently listed in
// the Financial Administration's 2026 calendar (see docs/epo-export-timing.md).
it.each([
  ["legal", "quarterly", "2026-Q3", "dphdp3"],
  ["natural", "quarterly", "2026-Q3", "dphkh1"],
  ["legal", "monthly", "2026-09", "dphkh1"],
] as const)("uses the actual ordinary output and period for %s %s %s %s", async (personType, filingFrequency, period, format) => {
  const user = await provisionedUser("Ordinary output deadline");
  const company = await createCompany(user.client, {
    organizationId: user.organizationId,
    ...companyDetails({ personType, filingFrequency, firstName: "Jana", lastName: "Nováková" }),
  });
  if (!company.ok) throw new Error(company.error);
  await generateVatReport(user.client, { companyId: company.value.id, period });
  const result = await exportVatReport(user.client, {
    companyId: company.value.id, period, format, details: { ...details, preparedOn: "2026-10-26" },
  }, () => new Date("2026-10-26T12:00:00Z"));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.timing.deadline).toBe("2026-10-26");
  expect(result.value.timing.warnings).toEqual([]);
  expect(result.value.timing.filingKind).toBe("ordinary");
  expect(result.value.xml).toContain(format === "dphdp3" ? 'dapdph_forma="B"' : 'khdph_forma="B"');
});

it.each([
  { preparedOn: "2026-02-30" },
  { preparedOn: "2026-05-01", economicActivity: "" },
])("keeps malformed dates and missing required data as export errors: %j", async (overrides) => {
  const company = await administratorWithCompany();
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-03" });
  expect(await exportVatReport(company.client, {
    companyId: company.companyId, period: "2026-03", format: "dphdp3", details: { ...details, ...overrides },
  }, () => new Date("2026-03-01T12:00:00Z"))).toEqual({ ok: false, error: "invalid_export_details" });
});

it("keeps timing advisories independent of Finalization and final XML generation", async () => {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, period: "2026-03" };
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId, taxOffice: "451", economicActivity: "621000",
    signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "director",
    email: "", phone: "", epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });
  await generateVatReport(company.client, input);
  expect(await finalizeVatReport(company.client, { ...input, confirmed: true })).toEqual({ ok: true, value: null });
  const result = await exportFinalVatReport(company.client, {
    ...input, format: "dphdp3", details: { preparedOn: "2026-05-01" },
  }, () => new Date("2026-03-01T12:00:00Z"));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.fileName).toBe("DPHDP3_2026-03.xml");
  expect(result.value.timing.warnings).toEqual(["prepared_on_future", "reporting_period_unfinished", "potentially_late_filing"]);
  expect(result.value.xml).toContain('dapdph_forma="B"');
});
it.each(["dphdp3", "dphkh1"])("serializes the selected territorial office and economic activity in validated %s", async (format) => {
  const company = await administratorWithCompany();
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const result = await exportVatReport(company.client, {
    companyId: company.companyId, period: "2026-10", format, details,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.xml).toContain('c_pracufo="2003"');
  if (format === "dphdp3") expect(result.value.xml).toContain('c_okec="621000"');
  else expect(result.value.xml).not.toContain("c_okec");
});

it("requires VAT Return economic activity while permitting a Control Statement without it", async () => {
  const company = await administratorWithCompany();
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const input = { companyId: company.companyId, period: "2026-10", details: { ...details, economicActivity: "" } };
  expect(await exportVatReport(company.client, { ...input, format: "dphdp3" })).toEqual({ ok: false, error: "invalid_export_details" });
  const control = await exportVatReport(company.client, { ...input, format: "dphkh1" });
  expect(control.ok).toBe(true);
  if (!control.ok) throw new Error(control.error);
  expect(control.value.xml).not.toContain("c_okec");
});

it("refuses a stale territorial office after a per-export tax-office change", async () => {
  const company = await administratorWithCompany();
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  expect(await exportVatReport(company.client, {
    companyId: company.companyId, period: "2026-10", format: "dphdp3",
    details: { ...details, taxOffice: "452" },
  })).toEqual({ ok: false, error: "invalid_export_details" });
});

it.each([
  ["451", false], ["13", true],
])("preserves the official optional regional office and specialized-office mapping for %s", async (taxOffice, specialized) => {
  const company = await administratorWithCompany();
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const result = await exportVatReport(company.client, {
    companyId: company.companyId, period: "2026-10", format: "dphdp3",
    details: { ...details, taxOffice, territorialOffice: "" },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  if (specialized) expect(result.value.xml).toContain('c_pracufo="4000"');
  else expect(result.value.xml).not.toContain("c_pracufo");
});
it("a Company User downloads a validated export of the saved draft, even after another approval", async () => {
  const a = await companyWithManyReportDocuments(2);
  const user = await companyMember(a);
  const input = {
    companyId: a.companyId,
    period: "2026-10",
    format: "dphdp3",
    details,
  };
  await generateVatReport(a.client, input);
  const [document] = await listCompanyDocuments(a.client, a.companyId);
  await approveDocument(a.client, {
    companyId: a.companyId,
    documentId: document.id,
    version: 1,
  });
  const saved = await exportVatReport(user.client, input);
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error);
  expect(saved.value).toEqual(
    expect.objectContaining({
      fileName: "DRAFT_DPHDP3_2026-10.xml",
      mediaType: "application/xml; charset=utf-8",
    }),
  );
  expect(saved.value.xml).toContain('odp_tuz23_nar="0"');
  await generateVatReport(a.client, input);
  const regenerated = await exportVatReport(user.client, input);
  expect(regenerated.ok && regenerated.value.xml).toContain(
    'odp_tuz23_nar="210"',
  );
});
it.each(["dphdp3", "dphkh1"])(
  "another Organization cannot export %s",
  async (format) => {
    const a = await administratorWithCompany();
    const b = await provisionedUser();
    await generateVatReport(a.client, {
      companyId: a.companyId,
      period: "2026-10",
    });
    expect(
      await exportVatReport(b.client, {
        companyId: a.companyId,
        period: "2026-10",
        format,
        details,
      }),
    ).toEqual({ ok: false, error: "report_not_found" });
  },
);

it.each(["dphdp3", "dphkh1"])(
  "resolves saved filing defaults and a confirmed EPO address for %s",
  async (format) => {
    const administrator = await provisionedUser();
    const company = await createCompany(administrator.client, {
      organizationId: administrator.organizationId,
      ...companyDetails({ streetName: "Dlouhá registrovaná ulice překračující limit EPO" }),
    });
    if (!company.ok) throw new Error(company.error);
    expect(await saveCompanyFilingDefaults(administrator.client, {
      companyId: company.value.id,
      taxOffice: "451",
      territorialOffice: "2003",
      economicActivity: "621000",
      signatoryFirstName: "Jana",
      signatoryLastName: "Nováková",
      signatoryCapacity: "jednatelka",
      email: "podatelna@example.test",
      phone: "+420123456789",
      epoAddressOverride: {
        streetName: "Dlouhá ulice",
        houseNumber: "12",
        orientationNumber: "3A",
        city: "Praha",
        postalCode: "120 00",
      },
      epoAddressConfirmed: true,
    })).toEqual({ ok: true, value: null });
    await generateVatReport(administrator.client, {
      companyId: company.value.id,
      period: "2026-10",
    });

    const result = await exportVatReport(administrator.client, {
      companyId: company.value.id,
      period: "2026-10",
      format,
      details: { preparedOn: "2026-10-27" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.xml).toContain('c_ufo="451"');
    expect(result.value.xml).toContain('c_pracufo="2003"');
    if (format === "dphdp3") expect(result.value.xml).toContain('c_okec="621000"');
    expect(result.value.xml).toContain('opr_jmeno="Jana"');
    expect(result.value.xml).toContain('email="podatelna@example.test"');
    expect(result.value.xml).toContain('c_telef="+420123456789"');
    expect(result.value.xml).toContain('ulice="Dlouhá ulice"');
    expect(result.value.xml).not.toContain("Dlouhá registrovaná");
  },
);

it("uses one-export overrides without mutating the saved filing defaults", async () => {
  const company = await administratorWithCompany();
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId,
    taxOffice: "451",
    territorialOffice: "2003",
    economicActivity: "621000",
    signatoryFirstName: "Jana",
    signatoryLastName: "Nováková",
    signatoryCapacity: "jednatelka",
    email: "default@example.test",
    phone: "+420123456789",
    epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });
  await generateVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  });

  const result = await exportVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-10",
    format: "dphdp3",
    details: {
      preparedOn: "2026-10-27",
      taxOffice: "452",
      territorialOffice: "2103",
      economicActivity: "622000",
      signatoryFirstName: "Petr",
      signatoryLastName: "Novák",
      signatoryCapacity: "jednatel",
      email: "one-off@example.test",
      phone: "",
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.xml).toContain('c_ufo="452"');
  expect(result.value.xml).toContain('c_pracufo="2103"');
  expect(result.value.xml).toContain('c_okec="622000"');
  expect(result.value.xml).toContain('opr_jmeno="Petr"');
  expect(result.value.xml).toContain('email="one-off@example.test"');
  expect(result.value.xml).not.toContain("c_telef");
  expect(await getCompanyFilingDefaults(company.client, company.companyId)).toEqual(
    expect.objectContaining({
      taxOffice: "451",
      territorialOffice: "2003",
      economicActivity: "621000",
      signatoryFirstName: "Jana",
      email: "default@example.test",
      phone: "+420123456789",
    }),
  );
});
it("refuses missing drafts and invalid export inputs without producing a download", async () => {
  const a = await administratorWithCompany();
  const input = {
    companyId: a.companyId,
    period: "2026-10",
    format: "dphdp3",
    details,
  };
  expect(await exportVatReport(a.client, input)).toEqual({
    ok: false,
    error: "report_not_found",
  });
  await generateVatReport(a.client, input);
  expect(
    await exportVatReport(a.client, { ...input, format: "../dphdp3" }),
  ).toEqual({ ok: false, error: "invalid_export_format" });
  expect(
    await exportVatReport(a.client, {
      ...input,
      details: { ...details, signatoryLastName: "" },
    }),
  ).toEqual({ ok: false, error: "invalid_export_details" });
});
it("uses the saved Company's person type for the XML header", async () => {
  const a = await provisionedUser();
  const company = await createCompany(a.client, {
    organizationId: a.organizationId,
    ...companyDetails({ personType: "natural", firstName: "Jan", lastName: "Novák" }),
  });
  if (!company.ok) throw new Error(company.error);
  const input = {
    companyId: company.value.id,
    period: "2026-10",
    format: "dphdp3",
    details: {
      ...details,
      personType: "P",
      firstName: "Injected",
      lastName: "Override",
    },
  };
  await generateVatReport(a.client, input);

  const result = await exportVatReport(a.client, input);

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.xml).toContain('typ_ds="F"');
  expect(result.value.xml).toContain('jmeno="Jan" prijmeni="Novák"');
  expect(result.value.xml).not.toContain("zkrobchjm");
});
it("uses a natural person's snapshotted identity without silently adding the User email", async () => {
  const administrator = await provisionedUser();
  const company = await createCompany(administrator.client, {
    organizationId: administrator.organizationId,
    ...companyDetails({ personType: "natural", firstName: "Jana", lastName: "Nováková" }),
  });
  if (!company.ok) throw new Error(company.error);
  expect(await saveCompanyFilingDefaults(administrator.client, {
    companyId: company.value.id,
    taxOffice: "451",
    territorialOffice: "2003",
    economicActivity: "621000",
    signatoryFirstName: "",
    signatoryLastName: "",
    signatoryCapacity: "",
    email: "",
    phone: "",
    epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });
  await generateVatReport(administrator.client, {
    companyId: company.value.id,
    period: "2026-10",
  });

  const result = await exportVatReport(administrator.client, {
    companyId: company.value.id,
    period: "2026-10",
    format: "dphdp3",
    details: {},
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.xml).toContain('typ_ds="F"');
  expect(result.value.xml).toContain('jmeno="Jana" prijmeni="Nováková"');
  expect(result.value.xml).not.toContain("email=");
  expect(result.value.xml).not.toContain("opr_jmeno");
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" })
    .format(new Date())
    .split("-")
    .reverse()
    .join(".");
  expect(result.value.xml).toContain(`d_poddp="${today}"`);
});
it.each(["dphdp3", "dphkh1"])(
  "requires a confirmed EPO address before exporting %s with an over-limit registered address",
  async (format) => {
    const a = await provisionedUser();
    const company = await createCompany(a.client, {
      organizationId: a.organizationId,
      ...companyDetails({ streetName: "x".repeat(39) }),
    });
    if (!company.ok) throw new Error(company.error);
    const input = {
      companyId: company.value.id,
      period: "2026-10",
      format,
      details,
    };
    await generateVatReport(a.client, input);
    expect(await exportVatReport(a.client, input)).toEqual({
      ok: false,
      error: "epo_address_required",
    });
  },
);
