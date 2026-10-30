import { describe, expect, it } from "vitest";
import { uploadSourceFile } from "@/application/source-files";
import { administratorWithCompany, platformCompanyInventoryFixture, storageObjectMetadataFixture } from "./support/fixtures";
import { signedUpUser } from "./support/clients";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";

describe("authenticated Source File Storage access", () => {
  it("lists only the authorized Company's objects among more than 1000 unrelated Companies and objects", async () => {
    const owner = await administratorWithCompany("Storage listing owner");
    const outsider = await signedUpUser("Storage listing outsider");
    const uploaded = await uploadSourceFile(owner.client, testWorker().jobs, {
      companyId: owner.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    const inventory = await platformCompanyInventoryFixture(1001, outsider.userId);
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
    }
  });

  it("retains first-folder authorization for nested paths while denying rootless and malformed paths", async () => {
    const owner = await administratorWithCompany("Storage path owner");
    const other = await administratorWithCompany("Storage path outsider");
    const allowed = [
      `${owner.companyId}/ordinary.pdf`, `${owner.companyId}/nested/original.pdf`,
      `${owner.companyId}//double.pdf`, `${owner.companyId}/`,
    ];
    const denied = [owner.companyId, `/${owner.companyId}/leading.pdf`, `${other.companyId}/foreign.pdf`, `invalid/${owner.companyId}`, ""];
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
});
