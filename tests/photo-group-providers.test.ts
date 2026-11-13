import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { expect, it } from "vitest";
import { platformAnthropicAiProvider } from "@/ai/anthropic";
import { platformOpenAiProvider } from "@/ai/openai";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { beginUploadBatch } from "@/application/upload-batches";
import { uploadSourceFile } from "./support/source-upload";
import { getPhotoGroup, photoGroupPath } from "@/application/photo-groups";
import { listExtractionVersions } from "@/application/documents";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
import { fixtureFile, heicFixture, rotatedHeicFixture, selectUploadFiles } from "./support/files";
import { testWorker } from "./support/worker";

it.each(["anthropic", "openai"] as const)("supplies %s the actual stored Photo Group pages without an additional PDF transform", async providerName => {
  type Content = { type: string; image_url?: string; source?: { data: string } };
  let received: Content[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: { content: Content[] }[]; messages?: { content: Content[] }[] };
    received = body.messages?.[0].content ?? body.input?.[0].content ?? [];
    const payload = { ...SAMPLE_EXTRACTION, sourceLocations: [{ fieldPath: "documentNumber", kind: "page", page: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.1 }] };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(providerName === "anthropic"
      ? { model: "local-extract", content: [{ type: "text", text: JSON.stringify(payload) }] }
      : { model: "local-extract", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local provider stand-in unavailable");
    const options = { baseUrl: `http://127.0.0.1:${address.port}` };
    const worker = testWorker(providerName === "anthropic" ? platformAnthropicAiProvider(options) : platformOpenAiProvider(options));
    const owner = await administratorWithCompany(), groupId = randomUUID();
    await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai });
    const selection = selectUploadFiles([
      { fileName: "first.jpg", bytes: new Uint8Array(await sharp({ create: { width: 80, height: 120, channels: 3, background: "#ff0000" } }).jpeg().toBuffer()) },
      { fileName: "second.heic", bytes: heicFixture() },
      { fileName: "third.png", bytes: fixtureFile("receipt.png") },
      { fileName: "fourth.heif", bytes: rotatedHeicFixture() },
    ]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 4, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of selection.files) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    expect(await worker.runJobs()).toEqual([]);
    const group = await getPhotoGroup(owner.client, owner.companyId, groupId);
    expect(group?.basis?.pages).toHaveLength(4);
    const images = received.filter(content => content.type === "image" || content.type === "input_image");
    expect(images).toHaveLength(4);
    for (const [index, image] of images.entries()) {
      const encoded = image.source?.data ?? image.image_url?.split(",")[1];
      const bytes = Buffer.from(encoded!, "base64");
      const original = await owner.client.storage.from("source-files").download(photoGroupPath(group!, `${index + 1}.png`));
      if (original.error) throw original.error;
      expect(bytes).toEqual(Buffer.from(await original.data.arrayBuffer()));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(group!.basis!.pages[index].sha256);
      const dimensions = await sharp(bytes).metadata();
      expect([dimensions.width, dimensions.height]).toEqual(index === 0 ? [80, 120] : index === 2 ? [1, 1] : [16, 16]);
    }
    const versions = await listExtractionVersions(owner.client, owner.companyId, groupId);
    expect(versions).toHaveLength(1);
    expect(versions[0].payload.sourceEvidence?.basis).toEqual({ kind: "photo_group", format: "pdf", sha256: group!.basis!.sha256, groupId });
    expect(versions[0].payload.sourceEvidence?.fields.documentNumber.locations[0]).toMatchObject({ page: 2 });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
