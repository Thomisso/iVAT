import { describe, expect, it } from "vitest";
import {
  createCompany,
  getCompany,
  getFilingFrequencyForPeriod,
  listCompanyFilingFrequencies,
  listMyCompanies,
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
  ico: "27082440",
  vatId: "CZ27082440",
  street: "Vinohradská 12",
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
      aiProcessing: null,
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
});

describe("Company details", () => {
  it("are normalized before saving", async () => {
    const { client, organizationId } = await signedUpUser();

    const result = await createCompany(client, {
      organizationId,
      name: "  Novák s.r.o. ",
      ico: " 27082440 ",
      vatId: "cz 27082440",
      street: " Vinohradská 12 ",
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
    [{ ico: "1234567" }, "invalid_ico"],
    [{ vatId: "SK2708244012" }, "invalid_vat_id"],
    [{ street: "" }, "address_required"],
    [{ city: "" }, "address_required"],
    [{ postalCode: "1200" }, "invalid_postal_code"],
  ])("are refused when invalid: %o", async (override, error) => {
    const { client, organizationId } = await signedUpUser();

    const result = await createCompany(client, { organizationId, ...companyDetails(override) });

    expect(result).toEqual({ ok: false, error });
    expect(await listMyCompanies(client)).toEqual([]);
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
      personType: "natural",
      filingFrequency: "quarterly",
      filingFrequencyEffectiveFrom: "2027-01-01",
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(await getCompany(client, companyId)).toEqual(
      expect.objectContaining({
        name: "Novák účetnictví s.r.o.",
        personType: "natural",
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
    expect(
      (await listAuditEvents(client, organizationId)).slice(-2),
    ).toEqual([
      expect.objectContaining({
        action: "company.updated",
        actorUserId: userId,
        companyId,
        payload: expect.objectContaining({
          name: {
            from: "Novák s.r.o.",
            to: "Novák účetnictví s.r.o.",
          },
          person_type: { from: "legal", to: "natural" },
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
});

it("opening a Company that does not exist finds nothing", async () => {
  const { client } = await signedUpUser();

  expect(await getCompany(client, "00000000-0000-0000-0000-000000000000")).toBeNull();
  expect(await getCompany(client, "not-a-uuid")).toBeNull();
});
