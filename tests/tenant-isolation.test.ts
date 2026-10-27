import { describe, expect, it } from "vitest";
import { createCompany, getCompany, listMyCompanies } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { getSourceFile, listSourceFiles, readSourceFile, uploadSourceFile } from "@/application/source-files";
import { anonymousClient, signedUpUser } from "./support/clients";
import { fixtureFile } from "./support/files";
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

  describe("of Source Files", () => {
    async function organizationWithSourceFile() {
      const a = await administratorWithCompany("Organization A");
      const pdf = fixtureFile("two-invoices.pdf");
      const result = await uploadSourceFile(a.client, { companyId: a.companyId, fileName: "a.pdf", bytes: pdf });
      if (!result.ok) throw new Error(result.error);
      return { ...a, sourceFileId: result.value.id, path: `${a.companyId}/${result.value.id}`, pdf };
    }

    it("hides another Organization's Source Files and their content", async () => {
      const a = await organizationWithSourceFile();
      const b = await signedUpUser("Organization B");

      expect(await listSourceFiles(b.client, a.companyId)).toEqual([]);
      expect(await getSourceFile(b.client, a.sourceFileId)).toBeNull();
      expect(await readSourceFile(b.client, a.sourceFileId)).toBeNull();
    });

    it("refuses to fetch another Organization's file from storage under the user's identity", async () => {
      const a = await organizationWithSourceFile();
      const b = await signedUpUser("Organization B");

      const download = await b.client.storage.from("source-files").download(a.path);
      const signedUrl = await b.client.storage.from("source-files").createSignedUrl(a.path, 60);
      const listing = await b.client.storage.from("source-files").list(a.companyId);
      const rows = await b.client.from("source_file").select("id").eq("company_id", a.companyId);

      expect(download.data).toBeNull();
      expect(signedUrl.data).toBeNull();
      expect(listing.data).toEqual([]);
      expect(rows.data).toEqual([]);
    });

    it("refuses uploads into another Organization's Company", async () => {
      const a = await organizationWithSourceFile();
      const b = await signedUpUser("Organization B");

      const result = await uploadSourceFile(b.client, { companyId: a.companyId, fileName: "b.pdf", bytes: a.pdf });
      const direct = await b.client.storage
        .from("source-files")
        .upload(`${a.companyId}/00000000-0000-4000-8000-000000000000`, a.pdf, { contentType: "application/pdf" });

      expect(result).toEqual({ ok: false, error: "forbidden" });
      expect(direct.error).not.toBeNull();
      expect(await listSourceFiles(a.client, a.companyId)).toHaveLength(1);
    });

    it("refuses direct changes to another Organization's Source Files", async () => {
      const a = await organizationWithSourceFile();
      const b = await signedUpUser("Organization B");

      const rename = await b.client.from("source_file").update({ file_name: "hijacked.pdf" }).eq("id", a.sourceFileId);
      const deleteRow = await b.client.from("source_file").delete().eq("id", a.sourceFileId);
      const removed = await b.client.storage.from("source-files").remove([a.path]);

      expect(rename.error?.code).toBe("42501");
      expect(deleteRow.error?.code).toBe("42501");
      expect(removed.data).toEqual([]);
      expect((await readSourceFile(a.client, a.sourceFileId))?.bytes).toEqual(a.pdf);
    });
  });

  it("gives an anonymous visitor no access to tenant data", async () => {
    const a = await administratorWithCompany("Organization A");
    const anonymous = anonymousClient();

    const companies = await anonymous.from("company").select("id").eq("id", a.companyId);

    expect(companies.error?.code).toBe("42501");
  });
});
