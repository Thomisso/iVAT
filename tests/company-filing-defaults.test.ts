import { expect, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import {
  getCompanyFilingDefaults,
  saveCompanyFilingDefaults,
} from "@/application/company-filing-defaults";
import {
  createCompany,
  getCompany,
  getCompanySetupChecklist,
  updateCompanyIdentity,
} from "@/application/companies";
import { provisionedUser } from "./support/clients";
import { administratorWithCompany, companyDetails, companyMember } from "./support/fixtures";

it("saves the economic activity and territorial office independently from statutory identity", async () => {
  const company = await administratorWithCompany();
  const identity = await getCompany(company.client, company.companyId);
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId, taxOffice: "451", territorialOffice: "2003", economicActivity: "621000",
    signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
    email: "", phone: "", epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });
  expect(await getCompanyFilingDefaults(company.client, company.companyId)).toEqual(expect.objectContaining({
    taxOffice: "451", territorialOffice: "2003", economicActivity: "621000",
  }));
  expect(await getCompany(company.client, company.companyId)).toEqual(identity);
});

it("refuses a territorial office from another tax office at the authoritative database boundary", async () => {
  const company = await administratorWithCompany();
  const result = await company.client.rpc("set_company_filing_defaults", {
    target_company_id: company.companyId,
    new_tax_office: "451", new_territorial_office: "2103", new_economic_activity: "621000",
    new_signatory_first_name: "", new_signatory_last_name: "", new_signatory_capacity: "",
    new_email: "", new_phone: "", new_epo_street_name: "", new_epo_house_number: "",
    new_epo_orientation_number: "", new_epo_city: "", new_epo_postal_code: "", epo_address_confirmed: false,
  });
  expect(result.error?.code).toBe("23503");
  expect(await getCompanyFilingDefaults(company.client, company.companyId)).toBeNull();
});

it.each([
  { taxOffice: "451", territorialOffice: "2103", economicActivity: "621000" },
  { taxOffice: "", territorialOffice: "2003", economicActivity: "621000" },
  { taxOffice: "451", territorialOffice: "2003", economicActivity: "999999" },
])("refuses incompatible or unknown filing catalogue values: %j", async (selection) => {
  const company = await administratorWithCompany();
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId, ...selection,
    signatoryFirstName: "", signatoryLastName: "", signatoryCapacity: "",
    email: "", phone: "", epoAddressOverride: null,
  })).toEqual({ ok: false, error: "invalid_filing_defaults" });
  expect(await getCompanyFilingDefaults(company.client, company.companyId)).toBeNull();
});

it("keeps incomplete filing defaults unset and the setup step unfinished", async () => {
  const company = await administratorWithCompany();
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId, taxOffice: "451",
    signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
    email: "", phone: "", epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });
  expect(await getCompanyFilingDefaults(company.client, company.companyId)).toEqual(expect.objectContaining({
    economicActivity: null, territorialOffice: null,
  }));
  expect(await getCompanySetupChecklist(company.client, company.companyId)).toContainEqual({ step: "filing_defaults", state: "skipped" });
});

it("saves filing defaults independently from the Company identity", async () => {
  const company = await administratorWithCompany();
  const identityBefore = await getCompany(company.client, company.companyId);

  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId,
    taxOffice: "451",
    territorialOffice: "2003",
    economicActivity: "621000",
    signatoryFirstName: "Jana",
    signatoryLastName: "Nováková",
    signatoryCapacity: "jednatelka",
    email: "podatelna@example.test",
    phone: "+420123456789",
    epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });

  expect(await getCompanyFilingDefaults(company.client, company.companyId)).toEqual({
    taxOffice: "451",
    territorialOffice: "2003",
    economicActivity: "621000",
    signatoryFirstName: "Jana",
    signatoryLastName: "Nováková",
    signatoryCapacity: "jednatelka",
    email: "podatelna@example.test",
    phone: "+420123456789",
    epoAddressOverride: null,
  });
  expect(await getCompany(company.client, company.companyId)).toEqual(identityBefore);
  expect(await getCompanySetupChecklist(company.client, company.companyId)).toContainEqual({
    step: "filing_defaults",
    state: "completed",
  });
});

it("audits filing-default changes without storing User personal data", async () => {
  const company = await administratorWithCompany();

  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId,
    taxOffice: "451",
    territorialOffice: "2003",
    economicActivity: "621000",
    signatoryFirstName: "Jana",
    signatoryLastName: "Nováková",
    signatoryCapacity: "jednatelka",
    email: "podatelna@example.test",
    phone: "+420123456789",
    epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });

  expect((await listAuditEvents(company.client, company.organizationId)).at(-1)).toEqual(
    expect.objectContaining({
      action: "company.filing_defaults_updated",
      companyId: company.companyId,
      targetType: "company",
      targetId: company.companyId,
      payload: {
        tax_office_set: true,
        economic_activity_set: true,
        territorial_office_set: true,
        signatory_set: true,
        email_set: true,
        phone_set: true,
        epo_address_override_set: false,
      },
    }),
  );
  expect(JSON.stringify((await listAuditEvents(company.client, company.organizationId)).at(-1)))
    .not.toContain("podatelna@example.test");
});

it("lets an Administrator edit filing defaults and refuses a Company User", async () => {
  const company = await administratorWithCompany();
  const administrator = await companyMember(company, "administrator");
  const user = await companyMember(company, "user");
  const input = {
    companyId: company.companyId,
    taxOffice: "452",
    territorialOffice: "2103",
    economicActivity: "621000",
    signatoryFirstName: "Petr",
    signatoryLastName: "Novák",
    signatoryCapacity: "jednatel",
    email: "",
    phone: "",
    epoAddressOverride: null,
  } as const;

  expect(await saveCompanyFilingDefaults(administrator.client, input)).toEqual({
    ok: true,
    value: null,
  });
  expect(await saveCompanyFilingDefaults(user.client, {
    ...input,
    economicActivity: "622000",
  })).toEqual({ ok: false, error: "forbidden" });
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.taxOffice).toBe("452");
});

it("requires an explicit EPO address confirmation only when the registered address exceeds schema limits", async () => {
  const administrator = await provisionedUser();
  const created = await createCompany(administrator.client, {
    organizationId: administrator.organizationId,
    ...companyDetails({ streetName: "Dlouhá registrovaná ulice překračující limit EPO" }),
  });
  if (!created.ok) throw new Error(created.error);
  const input = {
    companyId: created.value.id,
    taxOffice: "451",
    territorialOffice: "2003",
    economicActivity: "621000",
    signatoryFirstName: "Jana",
    signatoryLastName: "Nováková",
    signatoryCapacity: "jednatelka",
    email: "",
    phone: "",
    epoAddressOverride: {
      streetName: "Dlouhá ulice",
      houseNumber: "12",
      orientationNumber: "3A",
      city: "Praha",
      postalCode: "120 00",
    },
  } as const;

  expect(await saveCompanyFilingDefaults(administrator.client, input)).toEqual({
    ok: false,
    error: "epo_override_confirmation_required",
  });
  expect(await saveCompanyFilingDefaults(administrator.client, {
    ...input,
    epoAddressConfirmed: true,
  })).toEqual({ ok: true, value: null });
  expect((await getCompanyFilingDefaults(administrator.client, created.value.id))?.epoAddressOverride).toEqual(
    input.epoAddressOverride,
  );
  expect(await updateCompanyIdentity(administrator.client, {
    companyId: created.value.id,
    ...companyDetails({ streetName: "Jiná registrovaná ulice, která stále překračuje limit EPO" }),
  })).toEqual({ ok: true, value: null });
  expect(await getCompanyFilingDefaults(administrator.client, created.value.id)).toEqual({
    taxOffice: "451",
    territorialOffice: "2003",
    economicActivity: "621000",
    signatoryFirstName: "Jana",
    signatoryLastName: "Nováková",
    signatoryCapacity: "jednatelka",
    email: null,
    phone: null,
    epoAddressOverride: null,
  });

  const ordinary = await administratorWithCompany();
  expect(await saveCompanyFilingDefaults(ordinary.client, {
    ...input,
    companyId: ordinary.companyId,
    epoAddressConfirmed: true,
  })).toEqual({ ok: false, error: "epo_override_not_required" });
});

it("isolates filing defaults from another Organization", async () => {
  const company = await administratorWithCompany();
  const outsider = await provisionedUser("Other Organization");
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId,
    taxOffice: "451",
    territorialOffice: "2003",
    economicActivity: "621000",
    signatoryFirstName: "Jana",
    signatoryLastName: "Nováková",
    signatoryCapacity: "jednatelka",
    email: "",
    phone: "",
    epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });

  expect(await getCompanyFilingDefaults(outsider.client, company.companyId)).toBeNull();
  const visible = await outsider.client
    .from("company_filing_defaults")
    .select("tax_office")
    .eq("company_id", company.companyId);
  expect(visible.error).toBeNull();
  expect(visible.data).toEqual([]);
  const refused = await outsider.client
    .from("company_filing_defaults")
    .update({ tax_office: "452" })
    .eq("company_id", company.companyId);
  expect(refused.error?.code).toBe("42501");
});
