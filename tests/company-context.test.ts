import { describe, expect, it } from "vitest";
import { resolveCompanyContext } from "@/application/company-context";
import { createCompany } from "@/application/companies";
import { signedUpUser } from "./support/clients";
import { administratorWithCompany, companyDetails } from "./support/fixtures";

async function administratorWithTwoCompanies() {
  const user = await administratorWithCompany();
  const second = await createCompany(user.client, {
    organizationId: user.organizationId,
    ...companyDetails({ name: "Zeta s.r.o." }),
  });
  if (!second.ok) throw new Error(second.error);
  return { ...user, secondCompanyId: second.value.id };
}

describe("Company context", () => {
  it("opens the only accessible Company without requiring a remembered context", async () => {
    const user = await administratorWithCompany();

    expect(await resolveCompanyContext(user.client, null)).toEqual({
      kind: "company",
      companyId: user.companyId,
    });
  });

  it("requires an explicit choice when multiple Companies are accessible and none is remembered", async () => {
    const user = await administratorWithTwoCompanies();

    const context = await resolveCompanyContext(user.client, null);

    expect(context).toEqual({
      kind: "chooser",
      companies: expect.arrayContaining([
        expect.objectContaining({ id: user.companyId }),
        expect.objectContaining({ id: user.secondCompanyId }),
      ]),
    });
  });

  it("opens a remembered accessible Company for the same User", async () => {
    const user = await administratorWithTwoCompanies();

    expect(await resolveCompanyContext(user.client, {
      userId: user.userId,
      companyId: user.secondCompanyId,
    })).toEqual({ kind: "company", companyId: user.secondCompanyId });
  });

  it("does not reuse a remembered Company that belongs to another User", async () => {
    const user = await administratorWithTwoCompanies();
    const other = await signedUpUser("Other Organization");

    expect(await resolveCompanyContext(user.client, {
      userId: other.userId,
      companyId: user.companyId,
    })).toEqual({
      kind: "chooser",
      companies: expect.any(Array),
    });
  });

  it("does not silently replace an inaccessible remembered Company with the alphabetically first Company", async () => {
    const user = await administratorWithTwoCompanies();

    expect(await resolveCompanyContext(user.client, {
      userId: user.userId,
      companyId: "00000000-0000-0000-0000-000000000000",
    })).toEqual({
      kind: "chooser",
      companies: expect.any(Array),
    });
  });

  it("offers an empty chooser when the User cannot access a Company", async () => {
    const user = await signedUpUser();

    expect(await resolveCompanyContext(user.client, null)).toEqual({
      kind: "chooser",
      companies: [],
    });
  });
});
