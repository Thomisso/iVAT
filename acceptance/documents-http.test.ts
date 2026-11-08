import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { expect, it } from "vitest";
import { correctDocument, getDocument, listCompanyDocuments, listExtractionVersions } from "@/application/documents";
import { getSourceFile } from "@/application/source-files";
import { administratorWithCompany, assignAiConfigurationFixture } from "../tests/support/fixtures";
import { provisionedUser } from "../tests/support/clients";
import { fixtureFile, selectUploadFiles } from "../tests/support/files";
import { testWorker } from "../tests/support/worker";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { baseUrl, httpAs, inputTag, reviewedSource, value } from "./support/http";

it("uploads through public HTTP routes and observes the actual worker's terminal result", async () => {
  const owner = await administratorWithCompany("HTTP queued upload");
  const setup = testWorker();
  value(await assignAiConfigurationFixture(owner.client, setup.jobs, { companyId: owner.companyId, provider: setup.ai }));
  const request = await httpAs(owner.client);
  const selection = selectUploadFiles([{ fileName: "queued-http.pdf", bytes: fixtureFile("two-invoices.pdf") }]);
  const batchId = randomUUID();
  const companyPath = `/companies/${owner.companyId}`;
  const begin = await request(`${companyPath}/upload-batches`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ batchId, fileCount: 1, selectedFiles: selection.selectedFiles }),
  });
  expect(begin.status).toBe(201);
  expect(await begin.json()).toMatchObject({ ok: true, value: { id: batchId } });
  const file = selection.files[0];
  const form = new FormData();
  form.set("batchId", batchId); form.set("sourceFileId", file.sourceFileId);
  form.set("file", new Blob([Buffer.from(file.bytes)], { type: "application/pdf" }), file.fileName);
  const upload = await request(`${companyPath}/source-files`, { method: "POST", body: form });
  expect(upload.status).toBe(201);
  expect(await upload.json()).toMatchObject({ ok: true, value: { id: file.sourceFileId } });
  const finish = await request(`${companyPath}/upload-batches/${batchId}/finish`, { method: "POST" });
  expect(finish.status).toBe(200);
  expect(await finish.json()).toEqual({ ok: true, value: null });
  await expect.poll(async () => (await getSourceFile(owner.client, owner.companyId, file.sourceFileId))?.status,
    { timeout: 30_000, interval: 200 }).toBe("split");
  await expect.poll(async () => (await listCompanyDocuments(owner.client, owner.companyId)).map(document => document.status),
    { timeout: 30_000, interval: 200 }).toEqual(["needs_review", "needs_review"]);
  const original = await request(`${companyPath}/source-files/${file.sourceFileId}/content`);
  expect(original.status).toBe(200);
  expect(new Uint8Array(await original.arrayBuffer())).toEqual(file.bytes);
  expect(await (await request(`${companyPath}/upload-batches/${batchId}`)).text()).toContain(file.fileName);
  const stranger = await provisionedUser();
  const foreign = await (await httpAs(stranger.client))(`${companyPath}/upload-batches`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ batchId: randomUUID(), fileCount: 1, selectedFiles: selectUploadFiles([{ fileName: "foreign.pdf", bytes: file.bytes }]).selectedFiles }),
  });
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toEqual({ ok: false, error: "forbidden" });
});

it("returns current and recorded SSR values and protected original/page bytes without rewriting history", async () => {
  const fixture = await reviewedSource();
  const request = await httpAs(fixture.client);
  const companyPath = `/companies/${fixture.companyId}`;
  const path = `${companyPath}/documents/${fixture.document.id}`;
  value(await correctDocument(fixture.client, {
    companyId: fixture.companyId, documentId: fixture.document.id, basedOnVersion: 1,
    payload: { ...fixture.first.payload, documentNumber: "HTTP-CORRECTED-VERSION-2" },
  }, undefined, fakeVatPayerRegistry()));
  const current = await request(path);
  expect(current.status).toBe(200);
  expect(inputTag(await current.text(), "documentNumber")).toContain('value="HTTP-CORRECTED-VERSION-2"');
  const recorded = await request(`${path}?version=1`);
  expect(recorded.status).toBe(200);
  const recordedInput = inputTag(await recorded.text(), "documentNumber");
  expect(recordedInput).toContain(`value="${fixture.first.payload.documentNumber}"`);
  expect(recordedInput).toContain("disabled");
  const original = await request(`${companyPath}/source-files/${fixture.source.id}/content`);
  expect(original.status).toBe(200);
  expect(original.headers.get("content-type")).toBe("application/pdf");
  expect(original.headers.get("content-disposition")).toContain("http-original.pdf");
  expect(original.headers.get("cache-control")).toBe("private, max-age=3600, immutable");
  expect(original.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await original.arrayBuffer())).toEqual(fixture.original);
  const content = await request(`${path}/content?version=1`);
  expect(content.status).toBe(200);
  expect(content.headers.get("content-type")).toBe("application/pdf");
  expect((await PDFDocument.load(await content.arrayBuffer())).getPageCount()).toBe(1);
  expect((await request(`${path}/content?version=9999`)).status).toBe(404);
  const stranger = await provisionedUser();
  expect(await getDocument(stranger.client, fixture.companyId, fixture.document.id)).toBeNull();
  const foreign = await httpAs(stranger.client);
  for (const url of [path, `${path}/content`, `${companyPath}/source-files/${fixture.source.id}/content`]) {
    const response = await foreign(url);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("HTTP-CORRECTED-VERSION-2");
  }
  const anonymousUrl = new URL(`${path}/content`, baseUrl());
  const anonymous = await fetch(anonymousUrl, { redirect: "manual" });
  expect(anonymous.status).toBe(307);
  const location = anonymous.headers.get("location");
  expect(location?.trim()).toBeTruthy();
  const destination = new URL(location!, anonymousUrl);
  expect(destination.origin).toBe(anonymousUrl.origin);
  expect(destination.pathname).toBe("/login");
  expect((await listExtractionVersions(fixture.client, fixture.companyId, fixture.document.id)).map(version => version.version)).toEqual([1, 2]);
});
