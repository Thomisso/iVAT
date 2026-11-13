import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";
import { expect, it } from "vitest";
import { correctDocument, getDocument, listDocuments, listExtractionVersions } from "@/application/documents";
import { getPhotoGroup, photoGroupPath, readPhotoGroupBasis } from "@/application/photo-groups";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { getCompanyDataExportStatus } from "@/application/company-deletion";
import { beginUploadBatch, finishUploadBatch } from "@/application/upload-batches";
import { readSourceFileDerivative } from "@/application/source-files";
import { uploadSourceFile } from "../tests/support/source-upload";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { testWorker } from "../tests/support/worker";
import { administratorWithCompany, assignAiConfigurationFixture } from "../tests/support/fixtures";
import { fixtureFile, heicFixture, rotatedHeicFixture, selectUploadFiles } from "../tests/support/files";
import { httpAs, value } from "./support/http";

it.each(["heic", "heif"] as const)("selects the exact group PDF for %s-first review and preserves historical field/page identity", async format => {
  const owner = await administratorWithCompany("HTTP HEIC-first review");
  const groupId = randomUUID();
  const selection = selectUploadFiles([
    { fileName: `first.${format}`, bytes: format === "heic" ? heicFixture() : rotatedHeicFixture() },
    { fileName: "second.png", bytes: fixtureFile("receipt.png") },
    { fileName: "third.jpg", bytes: new Uint8Array(await sharp({ create: { width: 80, height: 120, channels: 3, background: "#ff0000" } }).jpeg().toBuffer()) },
  ]);
  let modelPages: Uint8Array[] = [];
  const worker = testWorker(fakeAiProvider({ extract: input => {
    if (input.pageImages) modelPages = input.pageImages.map(page => page.bytes);
    return { ...SAMPLE_EXTRACTION, sourceLocations: [{ fieldPath: "documentNumber", kind: "page", page: 3, x: 0.1, y: 0.2, width: 0.3, height: 0.1 }] };
  } }));
  value(await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai }));
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 3, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) }));
  for (const file of selection.files) value(await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.id, ...file }));
  await finishUploadBatch(owner.client, batch.id);
  expect(await worker.runJobsConcurrently()).toEqual([]);
  const group = (await getPhotoGroup(owner.client, owner.companyId, groupId))!;
  const [version] = await listExtractionVersions(owner.client, owner.companyId, groupId);
  expect(version.payload.sourceEvidence?.basis).toEqual({ kind: "photo_group", format: "pdf", groupId, sha256: group.basis!.sha256 });
  expect(version.payload.sourceEvidence?.fields.documentNumber.locations).toEqual([{ kind: "page", page: 3, x: 0.1, y: 0.2, width: 0.3, height: 0.1 }]);
  const request = await httpAs(owner.client);
  const path = `/companies/${owner.companyId}`;
  const contentPath = `${path}/documents/${groupId}/content`;
  const previewPath = `${path}/source-files/${selection.files[0].sourceFileId}/preview`;
  for (const query of ["", "?version=1"]) {
    const response = await request(`${path}/documents/${groupId}${query}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // The public SSR response serializes the content URL supplied to the PDF viewer.
    expect(html.includes(contentPath)).toBe(true);
    expect(html.includes(previewPath)).toBe(false);
    const content = await request(`${contentPath}?version=1`);
    expect(content.headers.get("Content-Type")).toBe("application/pdf");
    const bytes = new Uint8Array(await content.arrayBuffer());
    expect(bytes).toEqual((await readPhotoGroupBasis(owner.client, owner.companyId, groupId))?.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(version.payload.sourceEvidence?.basis.sha256);
    expect((await PDFDocument.load(bytes)).getPages().map(page => [page.getWidth(), page.getHeight()])).toEqual([[16, 16], [1, 1], [80, 120]]);
  }
  expect(group.basis!.pages.map(page => page.sourceFileId)).toEqual(selection.files.map(file => file.sourceFileId));
  expect(group.basis!.pages[0].sha256).toBe(format === "heic"
    ? "9339c93194e6e0fd13c075a0d9a8351d3ff52f186af16c16d4fc09ef827539a1"
    : "e8e79f3d7576bb64bab656481dd2cceaa72bf6831da8b0470379dd764120da43");
  for (const [index, page] of group.basis!.pages.entries()) {
    const stored = await owner.client.storage.from("source-files").download(photoGroupPath(group, `${page.page}.png`));
    if (stored.error) throw stored.error;
    const bytes = new Uint8Array(await stored.data.arrayBuffer());
    expect(bytes).toEqual(modelPages[index]);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(page.sha256);
  }
  expect(value(await correctDocument(owner.client, { companyId: owner.companyId, documentId: groupId, basedOnVersion: 1, payload: { ...version.payload, documentNumber: "HUMAN-CORRECTION" } })).version).toBe(2);
  expect((await listExtractionVersions(owner.client, owner.companyId, groupId))[0].payload.sourceEvidence).toEqual(version.payload.sourceEvidence);
  for (const query of ["", "?version=1"]) {
    const review = await request(`${path}/documents/${groupId}${query}`);
    expect(review.status).toBe(200);
    const html = await review.text();
    expect(html.includes(contentPath)).toBe(true);
    expect(html.includes(previewPath)).toBe(false);
  }
  for (const number of [1, 2]) {
    const content = await request(`${contentPath}?version=${number}`);
    expect(content.headers.get("Content-Type")).toBe("application/pdf");
    expect(createHash("sha256").update(new Uint8Array(await content.arrayBuffer())).digest("hex")).toBe(group.basis!.sha256);
  }
  const foreign = await administratorWithCompany("HTTP foreign HEIC-first review");
  const forbidden = await httpAs(foreign.client);
  expect((await forbidden(`${path}/documents/${groupId}?version=1`)).status).toBe(404);
  expect((await forbidden(`${contentPath}?version=1`)).status).toBe(404);

  // An ordinary HEIC/HEIF keeps its existing image preview instead of a group PDF.
  const standalone = value(await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, fileName: `ordinary.${format}`, bytes: format === "heic" ? rotatedHeicFixture() : heicFixture() }));
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(owner.client, owner.companyId, standalone.id);
  const ordinaryReview = await request(`${path}/documents/${document.id}`);
  expect(ordinaryReview.status).toBe(200);
  const standalonePreview = `${path}/source-files/${standalone.id}/preview`;
  expect(await ordinaryReview.text()).toContain(standalonePreview);
  const preview = await request(standalonePreview);
  expect(preview.headers.get("Content-Type")).toBe("image/jpeg");
  expect(new Uint8Array(await preview.arrayBuffer())).toEqual((await readSourceFileDerivative(owner.client, owner.companyId, standalone.id))?.bytes);
});

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

it("offers whole-group manual recovery over native Auth HTTP and returns the same one-Document receipt", async () => {
  const owner = await administratorWithCompany("HTTP group recovery");
  const worker = testWorker();
  value(await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai }));
  const groupId = randomUUID();
  const selection = selectUploadFiles([{ fileName: "first.heic", bytes: heicFixture() }, { fileName: "second.png", bytes: fixtureFile("receipt.png") }]);
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) }));
  for (const file of selection.files) value(await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.id, ...file }));
  await finishUploadBatch(owner.client, batch.id);
  const request = await httpAs(owner.client), path = `/companies/${owner.companyId}`;
  const source = await request(`${path}/source-files/${selection.files[1].sourceFileId}`);
  expect(source.status).toBe(200);
  expect((await source.text()).includes("Prepare whole group for manual review")).toBe(true);
  const recover = () => request(`${path}/photo-groups/${groupId}/recovery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "manual" }) });
  const first = await recover();
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, value: { id: groupId } });
  expect((await recover()).status).toBe(200);
  await expect.poll(async () => (await getDocument(owner.client, owner.companyId, groupId))?.status, { timeout: 30_000, interval: 200 }).toBe("needs_review");
  expect((await recover()).status).toBe(200);
  expect(await listExtractionVersions(owner.client, owner.companyId, groupId)).toEqual([]);
  expect(value(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).used).toBe(0);
  const basis = await request(`${path}/documents/${groupId}/content`);
  expect(basis.headers.get("Content-Type")).toBe("application/pdf");
  const bytes = new Uint8Array(await basis.arrayBuffer());
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe((await getPhotoGroup(owner.client, owner.companyId, groupId))?.basis?.sha256);
  for (const file of selection.files) expect(new Uint8Array(await (await request(`${path}/source-files/${file.sourceFileId}/content`)).arrayBuffer())).toEqual(file.bytes);
  const foreign = await administratorWithCompany("HTTP foreign recovery"), forbidden = await httpAs(foreign.client);
  expect((await forbidden(`${path}/photo-groups/${groupId}/recovery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"mode":"manual"}' })).status).toBe(403);
  expect((await request(`${path}/photo-groups/${groupId}/recovery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"mode":"replace"}' })).status).toBe(400);
});
