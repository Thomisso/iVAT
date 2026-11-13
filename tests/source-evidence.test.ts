import { PDFDocument } from "pdf-lib";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { createConfirmedManualDocument, setOctoberImportFixture } from "./support/claim-eligibility";
import { createCounterparty } from "@/application/counterparties";
import { fakeAiProvider } from "@/ai/fake";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { correctDocument, readDocumentPages, reprocessDocument, saveAndApproveDocument } from "@/application/documents";
import { writeFileSync } from "node:fs";
import { sourceEvidencePdfFixture } from "./support/source-evidence";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { openAiProvider } from "@/ai/openai";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { getDocumentReview } from "@/application/document-review";
import { listDocuments } from "@/application/documents";
import { getSourceFile, readSourceFile } from "@/application/source-files";
import { uploadSourceFile } from "./support/source-upload";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
import { testWorker } from "./support/worker";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

it("loads PDF evidence bound to the second Document's original page after zero-rate normalization", async () => {
  const extractionRequests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const split = body.text.format.name === "ivat_split";
    if (!split) extractionRequests.push(body);
    const output = split
      ? { documents: [{ firstPage: 1, lastPage: 1 }, { firstPage: 2, lastPage: 3 }] }
      : {
          ...SAMPLE_EXTRACTION,
          documentNumber: "PDF-EVIDENCE",
          rateBreakdown: [
            { rate: 12, netAmount: "0.00", vatAmount: "0.00" },
            { rate: 21, netAmount: "1000.00", vatAmount: "210.00" },
          ],
          sourceLocations: [
            { fieldPath: "documentNumber", kind: "page", page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
            { fieldPath: "documentNumber", kind: "page", page: 2, x: 0.2, y: 0.2, width: 0.4, height: 0.07 },
            { fieldPath: "rateBreakdown.1.vatAmount", kind: "page", page: 1, x: 0.7, y: 0.6, width: 0.2, height: 0.05 },
          ],
        };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: split ? "gpt-split" : "gpt-extract", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider stand-in did not bind");
  const provider = openAiProvider({
    apiKey: "test-secret", splitModel: "gpt-split", extractModel: "gpt-extract",
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  const worker = testWorker(provider);
  const admin = await administratorWithCompany();
  const configured = await assignAiConfigurationFixture(admin.client, worker.jobs, { companyId: admin.companyId, provider });
  if (!configured.ok) throw new Error(configured.error);
  const sourceBytes = await sourceEvidencePdfFixture();
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, {
    companyId: admin.companyId, fileName: "evidence-three-pages.pdf", bytes: sourceBytes,
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportFixture(uploaded.value.id);
  expect(await worker.runJobs()).toEqual([]);
  const documents = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  const second = documents.find((document) => document.firstPage === 2);
  if (!second) throw new Error("Second Document missing");
  const source = await getSourceFile(admin.client, admin.companyId, uploaded.value.id);
  expect((await readSourceFile(admin.client, admin.companyId, uploaded.value.id))?.bytes).toEqual(sourceBytes);
  const review = await getDocumentReview(admin.client, { companyId: admin.companyId, documentId: second.id });

  expect(review?.shown?.payload).toMatchObject({
    rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "210.00" }],
    sourceEvidence: {
      schemaVersion: 1, sourceFileId: uploaded.value.id, sourceSha256: source?.sha256, documentId: second.id,
      basis: { kind: "original", format: "pdf", sha256: source?.sha256 },
      range: { firstPage: 2, lastPage: 3 },
      fields: {
        documentNumber: {
          origin: "ai", originalValue: "PDF-EVIDENCE",
          locations: [
            { kind: "page", page: 2, x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
            { kind: "page", page: 3, x: 0.2, y: 0.2, width: 0.4, height: 0.07 },
          ],
        },
        "rateBreakdown.0.vatAmount": {
          origin: "ai", originalValue: "210.00",
          locations: [{ kind: "page", page: 2, x: 0.7, y: 0.6, width: 0.2, height: 0.05 }],
        },
      },
    },
  });
  if (process.env.IVAT_239_BROWSER_FIXTURE) writeFileSync(process.env.IVAT_239_BROWSER_FIXTURE, JSON.stringify({
    email: admin.email, password: "correct-horse-battery", companyId: admin.companyId,
    documentId: second.id, sourceFileId: uploaded.value.id, versionId: review?.shown?.id,
  }));
  expect(await readDocumentPages(admin.client, admin.companyId, second.id, 999)).toBeNull();
  expect(extractionRequests).toHaveLength(2);
  const content = (extractionRequests[1].input as { content: { type: string; image_url?: string; text?: string }[] }[])[0].content;
  expect(content.filter(item => item.type === "input_image")).toHaveLength(2);
  expect(content.some(item => item.type === "input_file")).toBe(false);
  expect(content.filter(item => item.type === "input_text").map(item => item.text)).toEqual(expect.arrayContaining([
    expect.stringContaining("Page 1 of 2"), expect.stringContaining("Page 2 of 2"),
  ]));
  expect(extractionRequests[1]).toMatchObject({
    text: { format: { schema: { required: expect.arrayContaining(["sourceLocations"]), properties: { sourceLocations: { type: "array" } } } } },
  });
});

it("retains only locked-base references with manual provenance and remapped deleted rate rows", async () => {
  const payload = {
    ...SAMPLE_EXTRACTION, documentNumber: "AI-ORIGINAL",
    rateBreakdown: [
      { rate: 21, netAmount: "100.00", vatAmount: "21.00" },
      { rate: 21, netAmount: "200.00", vatAmount: "42.00" },
      { rate: 21, netAmount: "300.00", vatAmount: "63.00" },
    ],
    totals: { netAmount: "600.00", vatAmount: "126.00", grossAmount: "726.00" },
    sourceLocations: [
      { fieldPath: "documentNumber", kind: "page" as const, page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      { fieldPath: "rateBreakdown.2.vatAmount", kind: "page" as const, page: 1, x: 0.7, y: 0.6, width: 0.2, height: 0.05 },
    ],
  };
  const worker = testWorker(fakeAiProvider({ extract: () => payload }));
  const admin = await administratorWithCompany();
  const configured = await assignAiConfigurationFixture(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
  if (!configured.ok) throw new Error(configured.error);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, { companyId: admin.companyId, fileName: "provenance.pdf", bytes: await sourceEvidencePdfFixture() });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportFixture(uploaded.value.id);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  const target = { companyId: admin.companyId, documentId: document.id };
  const original = (await getDocumentReview(admin.client, target))!.shown!;
  const changed = {
    ...original.payload, documentNumber: "HUMAN-EDIT",
    rateBreakdown: [payload.rateBreakdown[0], payload.rateBreakdown[2]],
    sourceRateRows: [0, 2],
    sourceEvidence: { ...original.payload.sourceEvidence!, sourceFileId: crypto.randomUUID() },
  };
  expect(await correctDocument(admin.client, { ...target, basedOnVersion: 1, payload: changed }, undefined, fakeVatPayerRegistry()))
    .toEqual({ ok: true, value: { version: 2 } });
  const review = (await getDocumentReview(admin.client, target))!;
  expect(review.shown!.payload.sourceEvidence).toMatchObject({
    sourceFileId: uploaded.value.id, documentId: document.id, extractionVersionId: review.shown!.id,
    fields: {
      documentNumber: { origin: "manual", originalValue: "AI-ORIGINAL" },
      "rateBreakdown.1.vatAmount": { origin: "ai", originalValue: "63.00" },
    },
  });
  expect(review.shown!.payload.sourceEvidence!.fields).not.toHaveProperty("rateBreakdown.2.vatAmount");
  expect(review.shown!.payload).not.toHaveProperty("sourceRateRows");
  expect(await correctDocument(admin.client, { ...target, basedOnVersion: 2, payload: {
    ...review.shown!.payload,
    rateBreakdown: [{ rate: 21, netAmount: "0.00", vatAmount: "0.00" }, payload.rateBreakdown[2]],
  } }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 3 } });
  const zeroed = (await getDocumentReview(admin.client, target))!.shown!;
  expect(zeroed.payload.sourceEvidence!.fields["rateBreakdown.0.vatAmount"])
    .toMatchObject({ origin: "ai", originalValue: "63.00" });
  expect(zeroed.payload.sourceEvidence!.fields).not.toHaveProperty("rateBreakdown.1.vatAmount");
  expect((await getDocumentReview(admin.client, { ...target, requestedVersion: "1" }))!.shown!.payload.sourceEvidence!.fields.documentNumber)
    .toMatchObject({ origin: "ai", originalValue: "AI-ORIGINAL" });
});

it("keeps each manual and AI Version's own evidence and never backfills missing locations", async () => {
  let calls = 0;
  const worker = testWorker(fakeAiProvider({ split: () => [{ firstPage: 1, lastPage: 3 }], extract: () => {
    calls++;
    return { ...SAMPLE_EXTRACTION, documentNumber: `AI-${calls}`, sourceLocations: [
      { fieldPath: "documentNumber", kind: "page", page: calls === 1 ? 1 : 2, x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
    ] };
  } }));
  const admin = await administratorWithCompany();
  const configured = await assignAiConfigurationFixture(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
  if (!configured.ok) throw new Error(configured.error);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, { companyId: admin.companyId, fileName: "history.pdf", bytes: await sourceEvidencePdfFixture() });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportFixture(uploaded.value.id);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  const target = { companyId: admin.companyId, documentId: document.id };
  const original = (await getDocumentReview(admin.client, target))!.shown!;
  const changed = { ...original.payload, documentNumber: "MANUAL-2" };
  expect(await correctDocument(admin.client, { ...target, basedOnVersion: 1, payload: changed }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  const corrected = (await getDocumentReview(admin.client, target))!.shown!;
  const approved = await saveAndApproveDocument(admin.client, { ...target, basedOnVersion: 2, requestId: crypto.randomUUID(), payload: { ...corrected.payload, documentNumber: "MANUAL-3" } }, undefined, fakeVatPayerRegistry());
  expect(approved).toEqual({ ok: true, value: { version: 3 } });
  const approvedVersion = (await getDocumentReview(admin.client, target))!.shown!;
  expect(approvedVersion.payload.sourceEvidence).toMatchObject({ extractionVersionId: approvedVersion.id, fields: { documentNumber: { origin: "manual", originalValue: "AI-1", locations: [{ page: 1 }] } } });
  expect(await reprocessDocument(admin.client, worker.jobs, { ...target, confirmed: true })).toEqual({ ok: true, value: null });
  expect(await worker.runJobs()).toEqual([]);
  const current = (await getDocumentReview(admin.client, target))!.shown!;
  expect(current).toMatchObject({ version: 4, payload: { documentNumber: "AI-2", sourceEvidence: { extractionVersionId: current.id, fields: { documentNumber: { origin: "ai", originalValue: "AI-2", locations: [{ page: 2 }] } } } } });
  expect((await getDocumentReview(admin.client, { ...target, requestedVersion: "1" }))!.shown!.payload).toEqual(original.payload);
  expect((await getDocumentReview(admin.client, { ...target, requestedVersion: "3" }))!.shown!.payload).toEqual(approvedVersion.payload);
  expect(calls).toBe(2);

  const manual = await createConfirmedManualDocument(admin.client, { companyId: admin.companyId, payload: { ...SAMPLE_EXTRACTION, sourceEvidence: current.payload.sourceEvidence } }, undefined, fakeVatPayerRegistry());
  if (!manual.ok) throw new Error(manual.error);
  const noSource = { companyId: admin.companyId, documentId: manual.value.id };
  const manualReview = (await getDocumentReview(admin.client, noSource))!;
  expect(manualReview.shown!.payload).not.toHaveProperty("sourceEvidence");
  expect(await saveAndApproveDocument(admin.client, { ...noSource, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: manualReview.shown!.payload }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 1 } });
  expect(calls).toBe(2);
});

it("ignores invalid PDF locations while sound financial data remains approvable without another AI call", async () => {
  let calls = 0;
  const worker = testWorker(fakeAiProvider({ split: () => [{ firstPage: 1, lastPage: 3 }], extract: () => {
    calls++;
    return { ...SAMPLE_EXTRACTION, sourceLocations: [
      { fieldPath: "documentNumber", kind: "page", page: 9, x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
      { fieldPath: "companyId", kind: "page", page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
    ] };
  } }));
  const admin = await administratorWithCompany();
  const party = SAMPLE_EXTRACTION.supplier;
  const known = await createCounterparty(admin.client, { companyId: admin.companyId, name: party.name!, ico: party.ico, vatId: party.vatId,
    street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false });
  if (!known.ok) throw new Error(known.error);
  const configured = await assignAiConfigurationFixture(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
  if (!configured.ok) throw new Error(configured.error);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, { companyId: admin.companyId, fileName: "missing-locations.pdf", bytes: await sourceEvidencePdfFixture() });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportFixture(uploaded.value.id);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  const target = { companyId: admin.companyId, documentId: document.id };
  const review = (await getDocumentReview(admin.client, target))!;
  expect(review.shown!.payload).not.toHaveProperty("sourceEvidence");
  expect(review.shown!.findings).toEqual([]);
  expect(await saveAndApproveDocument(admin.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: review.shown!.payload }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 1 } });
  expect(calls).toBe(1);
  expect(worker.queued).toEqual([]);
});


it("reads original pages without a Version while refusing explicit nonexistent Versions before first Extraction", async () => {
  const worker = testWorker(fakeAiProvider({ split: () => [{ firstPage: 1, lastPage: 1 }, { firstPage: 2, lastPage: 3 }] }));
  const admin = await administratorWithCompany();
  const configured = await assignAiConfigurationFixture(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
  if (!configured.ok) throw new Error(configured.error);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, { companyId: admin.companyId, fileName: "before-extraction.pdf", bytes: await sourceEvidencePdfFixture() });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportFixture(uploaded.value.id);
  await worker.runNextJob();
  const documents = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  const second = documents.find(document => document.firstPage === 2)!;
  expect((await getDocumentReview(admin.client, { companyId: admin.companyId, documentId: second.id }))!.shown).toBeUndefined();
  expect(await readDocumentPages(admin.client, admin.companyId, second.id)).toMatchObject({ fileName: "before-extraction.pdf", mediaType: "application/pdf", bytes: expect.any(Uint8Array) });
  expect(await readDocumentPages(admin.client, admin.companyId, second.id, 0)).toBeNull();
  expect(await readDocumentPages(admin.client, admin.companyId, second.id, 1)).toBeNull();
  if (process.env.IVAT_239_PREVIEW_FIXTURE) writeFileSync(process.env.IVAT_239_PREVIEW_FIXTURE, JSON.stringify({
    email: admin.email, password: "correct-horse-battery", companyId: admin.companyId, documentId: second.id,
  }));
});

it.each(["oversized", "renderer_unavailable"])("fails Extraction safely when PDF is %s", async (scenario) => {
  let calls = 0;
  const worker = testWorker(fakeAiProvider({ extract: () => { calls++; return SAMPLE_EXTRACTION; } }));
  const admin = await administratorWithCompany();
  const configured = await assignAiConfigurationFixture(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
  if (!configured.ok) throw new Error(configured.error);
  const pdf = await PDFDocument.create();
  pdf.addPage(scenario === "oversized" ? [10_000, 10_000] : [600, 800]);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, { companyId: admin.companyId, fileName: "render-failure.pdf", bytes: await pdf.save() });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await worker.runNextJob(); // Split is unchanged; the failure belongs to Extraction.
  const originalPath = process.env.PATH;
  let errors: unknown[];
  try {
    if (scenario === "renderer_unavailable") process.env.PATH = "/nonexistent-ivat-test-path";
    errors = await worker.runJobs();
  } finally { process.env.PATH = originalPath; }
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: scenario === "oversized" ? "pdf_render_limit" : "pdf_render_failed" });
  expect(calls).toBe(0);
  const [document] = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  expect(document.status).toBe("failed");
  expect((await getDocumentReview(admin.client, { companyId: admin.companyId, documentId: document.id }))!.shown).toBeUndefined();
  expect(await getCompanyAiProcessingAllowance(admin.client, admin.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
});
