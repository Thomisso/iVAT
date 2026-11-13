import { describe, expect, it } from "vitest";
import { uploadSourceFile } from "./support/source-upload";
import { administratorWithCompany, platformCompanyInventoryFixture, storageObjectMetadataFixture } from "./support/fixtures";
import { provisionedUser } from "./support/clients";
import { fixtureFile } from "./support/files";
import { testWorker, systemClient } from "./support/worker";
import { promotedSuperAdministrator } from "./support/platform";

describe("authenticated Source File Storage access", () => {
  it("lists only the authorized Company's objects among unrelated Companies and objects", async () => {
    const owner = await administratorWithCompany("Storage listing owner");
    const outsider = await provisionedUser("Storage listing outsider");
    const uploaded = await uploadSourceFile(owner.client, testWorker().jobs, {
      companyId: owner.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    const inventory = await platformCompanyInventoryFixture(31, outsider.userId);
    const removeMetadata = await storageObjectMetadataFixture(inventory.map((company) => `${company.companyId}/${crypto.randomUUID()}`));
    try {
      const denied = await outsider.client.storage.from("source-files").list(owner.companyId);
      expect(denied.error).toBeNull();
      expect(denied.data).toEqual([]);
      const own = await owner.client.storage.from("source-files").list(owner.companyId);
      expect(own.error).toBeNull();
      expect(own.data?.map((object) => object.name)).toEqual([uploaded.value.id]);
      const bytes = await owner.client.storage.from("source-files").download(`${owner.companyId}/${uploaded.value.id}`);
      expect(bytes.error).toBeNull();
      expect(new Uint8Array(await bytes.data!.arrayBuffer())).toEqual(fixtureFile("receipt.png"));
    } finally {
      await removeMetadata();
      const companies = await systemClient().from("company").delete().in("id", inventory.map(entry => entry.companyId));
      if (companies.error) throw companies.error;
      const deleted = await systemClient().from("organization").delete().in("id", inventory.map(entry => entry.organizationId));
      if (deleted.error) throw deleted.error;
    }
  });

  it("retains first-folder authorization for nested paths while denying rootless and malformed paths", async () => {
    const owner = await administratorWithCompany("Storage path owner");
    const other = await administratorWithCompany("Storage path outsider");
    const allowed = [
      `${owner.companyId}/ordinary.pdf`, `${owner.companyId}/nested/original.pdf`,
      `${owner.companyId}//double.pdf`, `${owner.companyId}/`,
    ];
    const denied = [
      owner.companyId, `/${owner.companyId}/leading.pdf`, `${other.companyId}/foreign.pdf`,
      `${owner.companyId.toUpperCase()}/uppercase.pdf`, `${owner.companyId.replaceAll("-", "")}/compact.pdf`,
      `{${owner.companyId}}/braced.pdf`, `invalid/${owner.companyId}`, "",
    ];
    const removeMetadata = await storageObjectMetadataFixture([...allowed, ...denied.filter(Boolean)]);
    try {
      const signed = await owner.client.storage.from("source-files").createSignedUrls([...allowed, ...denied], 60);
      expect(signed.error).toBeNull();
      for (const path of allowed) {
        const entry = signed.data?.find((candidate) => candidate.path === path);
        expect(entry?.error).toBeNull();
        expect(entry?.signedUrl).toContain("/storage/v1/object/sign/source-files/");
      }
      for (const path of denied) {
        const entry = signed.data?.find((candidate) => candidate.path === path);
        expect(entry?.error).toBeTruthy();
        expect(entry?.signedUrl).toBeNull();
      }
    } finally {
      await removeMetadata();
    }
  });

  it("preserves verified SuperAdmin inspection of rootless canonical names without accepting alternate UUID spellings", async () => {
    const target = await administratorWithCompany("Storage inspection target");
    const operator = await promotedSuperAdministrator("Storage inspection operator");
    const allowed = [target.companyId, `${target.companyId}/ordinary.pdf`, `${target.companyId}/nested/original.pdf`];
    const denied = [
      `${target.companyId.toUpperCase()}/uppercase.pdf`, `${target.companyId.replaceAll("-", "")}/compact.pdf`,
      `{${target.companyId}}/braced.pdf`, `/${target.companyId}/leading.pdf`, "invalid/object.pdf",
    ];
    const removeMetadata = await storageObjectMetadataFixture([...allowed, ...denied]);
    try {
      const signed = await operator.client.storage.from("source-files").createSignedUrls([...allowed, ...denied], 60);
      expect(signed.error).toBeNull();
      for (const path of allowed) {
        const entry = signed.data?.find((candidate) => candidate.path === path);
        expect(entry?.error).toBeNull();
        expect(entry?.signedUrl).toContain("/storage/v1/object/sign/source-files/");
      }
      for (const path of denied) {
        const entry = signed.data?.find((candidate) => candidate.path === path);
        expect(entry?.error).toBeTruthy();
        expect(entry?.signedUrl).toBeNull();
      }
    } finally {
      await removeMetadata();
    }
  });
});
