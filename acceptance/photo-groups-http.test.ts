import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";
import { expect, it } from "vitest";
import { getDocument, listExtractionVersions } from "@/application/documents";
import { getPhotoGroup, photoGroupPath, readPhotoGroupBasis } from "@/application/photo-groups";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { getCompanyDataExportStatus } from "@/application/company-deletion";
import { administratorWithCompany, assignAiConfigurationFixture } from "../tests/support/fixtures";
import { fixtureFile, heicFixture, rotatedHeicFixture, selectUploadFiles } from "../tests/support/files";
import { httpAs, value } from "./support/http";

it("uploads frozen ordered photographs through native Auth HTTP and preserves the worker basis in review and archive", async () => {
  const owner = await administratorWithCompany("HTTP Photo Groups");
  value(await assignAiConfigurationFixture(owner.client, { async send() {} }, { companyId: owner.companyId, provider: { name: "fake", region: "local" } }));
  const jpeg = new Uint8Array(await sharp({ create: { width: 80, height: 120, channels: 3, background: "#ff0000" } }).jpeg().toBuffer());
  const selection = selectUploadFiles([
    { fileName: "page-first.jpg", bytes: jpeg },
    { fileName: "page-second.heic", bytes: heicFixture() },
    { fileName: "page-third.png", bytes: fixtureFile("receipt.png") },
    { fileName: "page-fourth.heif", bytes: rotatedHeicFixture() },
  ]);
  const groupId = randomUUID(), batchId = randomUUID();
  const selectedFiles = selection.selectedFiles.map(file => ({ ...file, groupId }));
  const request = await httpAs(owner.client);
  const path = `/companies/${owner.companyId}`;
  const begin = (files = selectedFiles) => request(`${path}/upload-batches`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batchId, fileCount: 4, selectedFiles: files }) });
  expect((await begin()).status).toBe(201);
  expect((await begin()).status).toBe(201);
  expect((await begin([...selectedFiles].reverse())).status).toBe(400);
  for (const file of [...selection.files].reverse()) {
    const transferPath = `${path}/source-files/${file.sourceFileId}/transfer`;
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    const identity = { batchId, fileName: file.fileName, byteSize: file.bytes.length, sha256 };
    expect((await request(transferPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(identity) })).status).toBe(200);
    expect((await request(transferPath, { method: "PUT", headers: {
      "Upload-Batch-Id": batchId, "Upload-File-Name": encodeURIComponent(file.fileName), "Upload-Byte-Size": String(file.bytes.length), "Upload-Sha256": sha256, "Upload-Offset": "0",
    }, body: Buffer.from(file.bytes) })).status).toBe(200);
    const complete = () => request(transferPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...identity, complete: true }) });
    expect((await complete()).status).toBe(201);
    expect((await complete()).status).toBe(201);
  }
  expect((await request(`${path}/upload-batches/${batchId}/finish`, { method: "POST" })).status).toBe(200);
  await expect.poll(async () => (await getDocument(owner.client, owner.companyId, groupId))?.status, { timeout: 30_000, interval: 200 }).toBe("needs_review");
  expect(await listExtractionVersions(owner.client, owner.companyId, groupId)).toHaveLength(1);
  expect(value(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).used).toBe(1);
  const group = await getPhotoGroup(owner.client, owner.companyId, groupId);
  expect(group?.sourceFileIds).toEqual(selection.files.map(file => file.sourceFileId));
  const review = await request(`${path}/documents/${groupId}`);
  expect(review.status).toBe(200);
  const html = await review.text();
  expect(html).toContain("Ordered original photographs");
  for (const file of selection.files) {
    expect(html).toContain(file.fileName);
    const original = await request(`${path}/source-files/${file.sourceFileId}/content`);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(file.bytes);
  }
  const content = await request(`${path}/documents/${groupId}/content?version=1`);
  expect(content.headers.get("Content-Type")).toBe("application/pdf");
  const basisBytes = new Uint8Array(await content.arrayBuffer());
  expect((await PDFDocument.load(basisBytes)).getPageCount()).toBe(4);
  expect(basisBytes).toEqual((await readPhotoGroupBasis(owner.client, owner.companyId, groupId))?.bytes);
  for (const page of group!.basis!.pages) {
    const stored = await owner.client.storage.from("source-files").download(photoGroupPath(group!, `${page.page}.png`));
    if (stored.error) throw stored.error;
    expect(createHash("sha256").update(new Uint8Array(await stored.data.arrayBuffer())).digest("hex")).toBe(page.sha256);
  }
  const exported = await request(`${path}/export`, { method: "POST" });
  expect(exported.status).toBe(200);
  const archive = unzipSync(new Uint8Array(await exported.arrayBuffer()));
  expect(JSON.parse(strFromU8(archive[`photo-groups/${groupId}/manifest.json`])).sourceFileIds).toEqual(selection.files.map(file => file.sourceFileId));
  expect(archive[`photo-groups/${groupId}/basis.pdf`]).toEqual(basisBytes);
  for (const file of selection.files) expect(archive[`source-files/${file.sourceFileId}/${file.fileName}`]).toEqual(file.bytes);
  for (const index of [1, 3]) {
    const bytes = archive[`source-files/${selection.files[index].sourceFileId}/normalized.jpeg`];
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(index === 1
      ? "5a1dd9a99bd1a6d750a131e9a7148f70be5d95475861b3b57bcb44668e6f6cc8"
      : "268da1a5dfca47126246de862aedef33128afaddd56265457d5dea20beffaf22");
    expect(group?.basis?.pages[index].normalizedDerivative?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
  const exportId = exported.headers.get("X-Company-Export-Id")!;
  await expect.poll(async () => value(await getCompanyDataExportStatus(owner.client, { companyId: owner.companyId, exportId })), { timeout: 30_000, interval: 200 }).toBe("completed");
  const foreign = await administratorWithCompany("HTTP foreign Photo Groups");
  const foreignRequest = await httpAs(foreign.client);
  expect((await foreignRequest(`${path}/documents/${groupId}/content`)).status).toBe(404);
  expect((await foreignRequest(`${path}/source-files/${selection.files[0].sourceFileId}/content`)).status).toBe(404);
});
