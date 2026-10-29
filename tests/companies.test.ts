import { describe, expect, it } from "vitest";
import {
  createCompany,
  createCompanyIdentity,
  epoIdentityFindings,
  getCompany,
  getCompanySetupChecklist,
  getFilingFrequencyForPeriod,
  listCompanyFilingFrequencies,
  listMyCompanies,
  setCompanyFilingFrequency,
  updateCompany,
} from "@/application/companies";
import { listAuditEvents } from "@/application/audit";
import { signedUpUser } from "./support/clients";
import {
  administratorWithCompany,
  companyDetails,
  companyMember,
} from "./support/fixtures";

const novak = {
  name: "Novák s.r.o.",
  firstName: "",
  lastName: "",
  ico: "27082440",
  vatId: "CZ27082440",
  streetName: "Vinohradská",
  houseNumber: "12",
  orientationNumber: "",
  city: "Praha",
  postalCode: "120 00",
  personType: "legal" as const,
};

const initialFiling = {
  filingFrequency: "monthly" as const,
  filingFrequencyEffectiveFrom: "2026-01-01",
};

describe("Company creation", () => {
  it("lets the Organization Administrator create a Company and open it", async () => {
    const { client, organizationId } = await signedUpUser();

    const result = await createCompany(client, {
      organizationId,
      ...novak,
      ...initialFiling,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await getCompany(client, result.value.id)).toEqual({
      id: result.value.id,
      organizationId,
      ...novak,
      firstName: null,
      lastName: null,
      street: "Vinohradská 12",
      orientationNumber: null,
      aiProcessingEnabled: false,
    });
    expect(await listCompanyFilingFrequencies(client, result.value.id)).toEqual([
      { frequency: "monthly", effectiveFrom: "2026-01-01" },
    ]);
    expect(
      await getFilingFrequencyForPeriod(client, result.value.id, "2026-10"),
    ).toBe("monthly");
    expect(await listMyCompanies(client)).toEqual([
      { id: result.value.id, organizationId, name: "Novák s.r.o." },
    ]);
  });

  it("persists natural-person identity before filing frequency and resumes from the blocking step", async () => {
    const { client, organizationId } = await signedUpUser();
    const identity = await createCompanyIdentity(client, {
      organizationId,
      ...companyDetails({
        personType: "natural",
        name: "ignored legal name",
        firstName: " Jana ",
        lastName: " Nováková ",
        orientationNumber: "53A",
      }),
    });
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    expect(await getCompany(client, identity.value.id)).toEqual(expect.objectContaining({
      name: "Jana Nováková",
      firstName: "Jana",
      lastName: "Nováková",
      streetName: "Vinohradská",
      houseNumber: "12",
      orientationNumber: "53A",
    }));
    expect(await getCompanySetupChecklist(client, identity.value.id)).toEqual([
      { step: "identity", state: "completed" },
      { step: "filing_frequency", state: "blocking" },
      { step: "filing_defaults", state: "skipped" },
      { step: "ai_processing", state: "skipped" },
    ]);
    expect(await setCompanyFilingFrequency(client, {
      companyId: identity.value.id,
      filingFrequency: "quarterly",
      filingFrequencyEffectiveFrom: "2026-04-01",
    })).toEqual({ ok: true, value: null });
    expect((await getCompanySetupChecklist(client, identity.value.id))[1]).toEqual({
      step: "filing_frequency", state: "completed",
    });
  });
});

describe("Company details", () => {
  it("are normalized before saving", async () => {
    const { client, organizationId } = await signedUpUser();

    const result = await createCompany(client, {
      organizationId,
      name: "  Novák s.r.o. ",
      firstName: "",
      lastName: "",
      ico: " 27082440 ",
      vatId: "cz 27082440",
      streetName: " Vinohradská ",
      houseNumber: "12",
      orientationNumber: "",
      city: " Praha ",
      postalCode: "12000",
      personType: "legal",
      ...initialFiling,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await getCompany(client, result.value.id)).toEqual(
      expect.objectContaining({ name: "Novák s.r.o.", ico: "27082440", vatId: "CZ27082440", postalCode: "120 00" }),
    );
  });

  it.each([
    [{ name: " " }, "name_required"],
    [{ personType: "natural" as const, firstName: "", lastName: "Novák" }, "first_name_required"],
    [{ personType: "natural" as const, firstName: "Jana", lastName: "" }, "last_name_required"],
    [{ ico: "1234567" }, "invalid_ico"],
    [{ vatId: "SK2708244012" }, "invalid_vat_id"],
    [{ streetName: "" }, "address_required"],
    [{ city: "" }, "address_required"],
    [{ houseNumber: "12A" }, "invalid_house_number"],
    [{ orientationNumber: "1234A" }, "invalid_orientation_number"],
    [{ name: "x".repeat(256) }, "name_too_long"],
    [{ personType: "natural" as const, firstName: "x".repeat(31), lastName: "Novák" }, "first_name_too_long"],
    [{ personType: "natural" as const, firstName: "Jana", lastName: "x".repeat(37) }, "last_name_too_long"],
    [{ postalCode: "1200" }, "invalid_postal_code"],
  ])("are refused when invalid: %o", async (override, error) => {
    const { client, organizationId } = await signedUpUser();

    const result = await createCompany(client, { organizationId, ...companyDetails(override) });

    expect(result).toEqual({ ok: false, error });
    expect(await listMyCompanies(client)).toEqual([]);
  });

  it("preserves valid registered data that exceeds EPO limits and reports field-specific findings", async () => {
    const { client, organizationId } = await signedUpUser();
    const streetName = "Dlouhá registrovaná ulice s nezkráceným názvem";
    const city = "Městská část s pravdivým názvem delším než limit EPO formuláře";

    const result = await createCompany(client, {
      organizationId,
      ...companyDetails({ streetName, city }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await getCompany(client, result.value.id)).toEqual(expect.objectContaining({ streetName, city }));
    expect(epoIdentityFindings({ streetName, orientationNumber: "53A", city })).toEqual([
      { field: "streetName", code: "epo_street_name_too_long" },
      { field: "city", code: "epo_city_too_long" },
    ]);
  });

  it("are refused when the IČO is already used in the Organization", async () => {
    const { client, organizationId, companyId } = await administratorWithCompany();
    const existing = await getCompany(client, companyId);

    const result = await createCompany(client, { organizationId, ...companyDetails({ ico: existing!.ico }) });

    expect(result).toEqual({ ok: false, error: "ico_taken" });
  });

  it("keeps effective-dated filing frequency history and audits Company changes", async () => {
    const { client, userId, organizationId, companyId } =
      await administratorWithCompany();
    const existing = await getCompany(client, companyId);
    if (!existing) throw new Error("Company not found");

    const result = await updateCompany(client, {
      companyId,
      ...existing,
      name: "Novák účetnictví s.r.o.",
      personType: "legal",
      filingFrequency: "quarterly",
      filingFrequencyEffectiveFrom: "2027-01-01",
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(await getCompany(client, companyId)).toEqual(
      expect.objectContaining({
        name: "Novák účetnictví s.r.o.",
        personType: "legal",
      }),
    );
    expect(await listCompanyFilingFrequencies(client, companyId)).toEqual([
      { frequency: "monthly", effectiveFrom: "2026-01-01" },
      { frequency: "quarterly", effectiveFrom: "2027-01-01" },
    ]);
    expect(
      await getFilingFrequencyForPeriod(client, companyId, "2026-12"),
    ).toBe("monthly");
    expect(
      await getFilingFrequencyForPeriod(client, companyId, "2027-Q2"),
    ).toBe("quarterly");
    const relevantEvents = (await listAuditEvents(client, organizationId)).filter(
      (event) => event.action === "company.updated" || event.action === "company.filing_frequency_changed",
    );
    expect(relevantEvents.slice(-2)).toEqual([
      expect.objectContaining({
        action: "company.updated",
        actorUserId: userId,
        companyId,
        payload: expect.objectContaining({
          name: {
            from: "Novák s.r.o.",
            to: "Novák účetnictví s.r.o.",
          },
        }),
      }),
      expect.objectContaining({
        action: "company.filing_frequency_changed",
        actorUserId: userId,
        companyId,
        payload: {
          effective_from: "2027-01-01",
          frequency: "quarterly",
        },
      }),
    ]);
  });

  it("lets a Company Administrator edit settings and refuses a Company User", async () => {
    const company = await administratorWithCompany();
    const administrator = await companyMember(company, "administrator");
    const user = await companyMember(company, "user");
    const existing = await getCompany(company.client, company.companyId);
    if (!existing) throw new Error("Company not found");
    const change = {
      companyId: company.companyId,
      ...existing,
      name: "Administrator changed this",
      filingFrequency: "monthly" as const,
      filingFrequencyEffectiveFrom: "2026-01-01",
    };

    expect(await updateCompany(administrator.client, change)).toEqual({
      ok: true,
      value: null,
    });
    expect(
      await updateCompany(user.client, { ...change, name: "User changed this" }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect((await getCompany(company.client, company.companyId))?.name).toBe(
      "Administrator changed this",
    );
  });

  it("enforces quarter boundaries across the full filing-frequency history", async () => {
    const company = await administratorWithCompany();
    expect(await setCompanyFilingFrequency(company.client, {
      companyId: company.companyId,
      filingFrequency: "quarterly",
      filingFrequencyEffectiveFrom: "2027-01-01",
    })).toEqual({ ok: true, value: null });

    expect(await setCompanyFilingFrequency(company.client, {
      companyId: company.companyId,
      filingFrequency: "monthly",
      filingFrequencyEffectiveFrom: "2027-02-01",
    })).toEqual({ ok: false, error: "invalid_effective_from" });
    expect(await listCompanyFilingFrequencies(company.client, company.companyId)).toEqual([
      { frequency: "monthly", effectiveFrom: "2026-01-01" },
      { frequency: "quarterly", effectiveFrom: "2027-01-01" },
    ]);

    const legacyBypass = await company.client.rpc("update_company", {
      target_company_id: company.companyId,
      company_name: "Legacy bypass",
      company_ico: "27082440",
      company_vat_id: "CZ27082440",
      company_street: "Legacy 1",
      company_city: "Praha",
      company_postal_code: "110 00",
      company_person_type: "legal",
      new_filing_frequency: "monthly",
      filing_frequency_effective_from: "2027-02-01",
    });
    expect(legacyBypass.error?.code).toBe("42501");
  });

  it("isolates persisted setup state from another Organization", async () => {
    const company = await administratorWithCompany();
    const outsider = await signedUpUser("Other Organization");

    const visible = await outsider.client
      .from("company_setup_step_state")
      .select("step, state")
      .eq("company_id", company.companyId);
    expect(visible.error).toBeNull();
    expect(visible.data).toEqual([]);
    const refused = await outsider.client
      .from("company_setup_step_state")
      .update({ state: "skipped" })
      .eq("company_id", company.companyId);
    expect(refused.error?.code).toBe("42501");
  });
});

it("opening a Company that does not exist finds nothing", async () => {
  const { client } = await signedUpUser();

  expect(await getCompany(client, "00000000-0000-0000-0000-000000000000")).toBeNull();
  expect(await getCompany(client, "not-a-uuid")).toBeNull();
});
