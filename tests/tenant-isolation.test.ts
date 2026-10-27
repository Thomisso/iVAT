import { describe, expect, it } from "vitest";
import { createCompany, getCompany, listMyCompanies } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { anonymousClient, signedUpUser } from "./support/clients";
import { administratorWithCompany, companyDetails } from "./support/fixtures";

describe("tenant isolation", () => {
  it("hides another Organization and its Companies from the application layer", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await signedUpUser("Organization B");

    expect((await listMyOrganizations(b.client)).map((o) => o.name)).toEqual(["Organization B"]);
    expect(await listMyCompanies(b.client)).toEqual([]);
    expect(await getCompany(b.client, a.companyId)).toBeNull();
  });

  it("refuses to create a Company in another Organization", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await signedUpUser("Organization B");

    const result = await createCompany(b.client, { organizationId: a.organizationId, ...companyDetails() });

    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(await listMyCompanies(a.client)).toHaveLength(1);
  });

  it("returns nothing of another Organization to direct queries under the user's identity", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await signedUpUser("Organization B");

    const organizations = await b.client.from("organization").select("id").eq("id", a.organizationId);
    const companies = await b.client.from("company").select("id").eq("organization_id", a.organizationId);
    const memberships = await b.client.from("membership").select("id").eq("organization_id", a.organizationId);

    expect(organizations.data).toEqual([]);
    expect(companies.data).toEqual([]);
    expect(memberships.data).toEqual([]);
  });

  it("refuses direct modification of another Organization under the user's identity", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await signedUpUser("Organization B");

    const renameOrganization = await b.client.from("organization").update({ name: "Hijacked" }).eq("id", a.organizationId);
    const renameCompany = await b.client.from("company").update({ name: "Hijacked" }).eq("id", a.companyId);
    const deleteCompany = await b.client.from("company").delete().eq("id", a.companyId);
    const joinOrganization = await b.client
      .from("membership")
      .insert({ user_id: b.userId, organization_id: a.organizationId, role: "administrator" });

    for (const attempt of [renameOrganization, renameCompany, deleteCompany, joinOrganization]) {
      expect(attempt.error?.code).toBe("42501");
    }
    expect((await listMyOrganizations(a.client)).map((o) => o.name)).toEqual(["Organization A"]);
    expect((await getCompany(a.client, a.companyId))?.name).toBe("Novák s.r.o.");
    expect((await listMyOrganizations(b.client)).map((o) => o.name)).toEqual(["Organization B"]);
  });

  it("gives an anonymous visitor no access to tenant data", async () => {
    const a = await administratorWithCompany("Organization A");
    const anonymous = anonymousClient();

    const companies = await anonymous.from("company").select("id").eq("id", a.companyId);

    expect(companies.error?.code).toBe("42501");
  });
});
