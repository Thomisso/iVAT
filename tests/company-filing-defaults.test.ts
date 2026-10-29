import { expect, it } from "vitest";
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
import { signedUpUser } from "./support/clients";
import { administratorWithCompany, companyDetails, companyMember } from "./support/fixtures";

it("saves filing defaults independently from the Company identity", async () => {
  const company = await administratorWithCompany();
  const identityBefore = await getCompany(company.client, company.companyId);

  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId,
    taxOffice: "451",
    signatoryFirstName: "Jana",
    signatoryLastName: "Nováková",
    signatoryCapacity: "jednatelka",
    email: "podatelna@example.test",
    phone: "+420123456789",
    epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });

  expect(await getCompanyFilingDefaults(company.client, company.companyId)).toEqual({
    taxOffice: "451",
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

it("lets an Administrator edit filing defaults and refuses a Company User", async () => {
  const company = await administratorWithCompany();
  const administrator = await companyMember(company, "administrator");
  const user = await companyMember(company, "user");
  const input = {
    companyId: company.companyId,
    taxOffice: "452",
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
    taxOffice: "453",
  })).toEqual({ ok: false, error: "forbidden" });
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.taxOffice).toBe("452");
});

it("requires an explicit EPO address confirmation only when the registered address exceeds schema limits", async () => {
  const administrator = await signedUpUser();
  const created = await createCompany(administrator.client, {
    organizationId: administrator.organizationId,
    ...companyDetails({ streetName: "Dlouhá registrovaná ulice překračující limit EPO" }),
  });
  if (!created.ok) throw new Error(created.error);
  const input = {
    companyId: created.value.id,
    taxOffice: "451",
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
    ...companyDetails(),
  })).toEqual({ ok: true, value: null });
  expect((await getCompanyFilingDefaults(administrator.client, created.value.id))?.epoAddressOverride).toBeNull();

  const ordinary = await administratorWithCompany();
  expect(await saveCompanyFilingDefaults(ordinary.client, {
    ...input,
    companyId: ordinary.companyId,
    epoAddressConfirmed: true,
  })).toEqual({ ok: false, error: "epo_override_not_required" });
});

it("isolates filing defaults from another Organization", async () => {
  const company = await administratorWithCompany();
  const outsider = await signedUpUser("Other Organization");
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId,
    taxOffice: "451",
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
