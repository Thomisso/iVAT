import { createServer } from "node:http";
import { afterEach, expect, inject, it } from "vitest";
import sharp from "sharp";
import * as XLSX from "xlsx";
import { heicFixture, fixtureFile, workbookFile } from "./support/files";
import { openAiProvider } from "@/ai/openai";
import { SAMPLE_EXTRACTION, fakeAiProvider } from "@/ai/fake";
import { listDocuments, readDocumentRows, correctDocument, reprocessDocument, saveAndApproveDocument } from "@/application/documents";
import { getDocumentReview } from "@/application/document-review";
import { getSourceFile, readSourceFile, readSourceFileDerivative, uploadSourceFile } from "@/application/source-files";
import { setCompanyAutomaticApproval } from "@/application/companies";
import { withClaimDate } from "./support/claim-clock";
import { createCounterparty } from "@/application/counterparties";
import { createConfirmedManualDocument, setOctoberImportFixture } from "./support/claim-eligibility";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
import { testWorker } from "./support/worker";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

it.each(["png", "jpeg"] as const)("loads %s image locations bound to the actual Source File and immutable Version without changing original bytes", async (format) => {
  const sourceBytes = new Uint8Array(await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="white"/><text x="60" y="110" font-size="20">IMAGE-240</text><text x="420" y="500" font-size="20">210.00</text></svg>')).toFormat(format).toBuffer());
  let imageSent: Uint8Array | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const split = body.text.format.name === "ivat_split";
    if (!split) {
      const image = body.input[0].content.find((entry: { type: string }) => entry.type === "input_image");
      imageSent = new Uint8Array(Buffer.from(image.image_url.split(",")[1], "base64"));
    }
    const output = split ? { documents: [{ firstPage: 1, lastPage: 1 }] } : {
      ...SAMPLE_EXTRACTION, documentNumber: "IMAGE-240", sourceLocations: [
        { fieldPath: "documentNumber", kind: "page", page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      ],
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: split ? "gpt-split" : "gpt-extract", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider stand-in did not bind");
  const provider = openAiProvider({ apiKey: "test-secret", splitModel: "gpt-split", extractModel: "gpt-extract", baseUrl: `http://127.0.0.1:${address.port}` });
  const worker = testWorker(provider);
  const admin = await administratorWithCompany();
  const configured = await assignAiConfigurationFixture(admin.client, worker.jobs, { companyId: admin.companyId, provider });
  if (!configured.ok) throw new Error(configured.error);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, { companyId: admin.companyId, fileName: `image-evidence.${format}`, bytes: sourceBytes });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  const source = await getSourceFile(admin.client, admin.companyId, uploaded.value.id);
  const review = (await getDocumentReview(admin.client, { companyId: admin.companyId, documentId: document.id }))!;
  expect(imageSent).toEqual(sourceBytes);
  expect((await readSourceFile(admin.client, admin.companyId, uploaded.value.id))?.bytes).toEqual(sourceBytes);
  expect(review.shown?.payload.sourceEvidence).toEqual({
    schemaVersion: 1, sourceFileId: uploaded.value.id, sourceSha256: source!.sha256, documentId: document.id,
    extractionVersionId: review.shown!.id, originExtractionRequestId: expect.any(String),
    basis: { kind: "original", format, sha256: source!.sha256 }, range: { firstPage: 1, lastPage: 1 },
    fields: { documentNumber: { origin: "ai", originalValue: "IMAGE-240", locations: [
      { kind: "page", page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
    ] } },
  });
});

it("binds HEIC evidence to the exact persisted normalized JPEG sent to AI and served in preview", async () => {
  const sourceBytes = heicFixture();
  let imageSent: Uint8Array | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const split = body.text.format.name === "ivat_split";
    if (!split) {
      const image = body.input[0].content.find((entry: { type: string }) => entry.type === "input_image");
      imageSent = new Uint8Array(Buffer.from(image.image_url.split(",")[1], "base64"));
    }
    const output = split ? { documents: [{ firstPage: 1, lastPage: 1 }] } : {
      ...SAMPLE_EXTRACTION, documentNumber: "IMAGE-240", sourceLocations: [
        { fieldPath: "documentNumber", kind: "page", page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      ],
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: split ? "gpt-split" : "gpt-extract", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider stand-in did not bind");
  const provider = openAiProvider({ apiKey: "test-secret", splitModel: "gpt-split", extractModel: "gpt-extract", baseUrl: `http://127.0.0.1:${address.port}` });
  const worker = testWorker(provider);
  const admin = await administratorWithCompany();
  const configured = await assignAiConfigurationFixture(admin.client, worker.jobs, { companyId: admin.companyId, provider });
  if (!configured.ok) throw new Error(configured.error);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, { companyId: admin.companyId, fileName: "heic-evidence.heic", bytes: sourceBytes });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  const source = await getSourceFile(admin.client, admin.companyId, uploaded.value.id);
  const review = (await getDocumentReview(admin.client, { companyId: admin.companyId, documentId: document.id }))!;
  const derivative = (await readSourceFileDerivative(admin.client, admin.companyId, uploaded.value.id))!;
  expect(derivative).toMatchObject({ sourceFileId: uploaded.value.id, originalSha256: source!.sha256, format: "jpeg", sha256: source!.normalizedDerivative!.sha256 });
  expect(imageSent).toEqual(derivative.bytes);
  expect((await readSourceFile(admin.client, admin.companyId, uploaded.value.id))?.bytes).toEqual(sourceBytes);
  expect(review.shown?.payload.sourceEvidence).toEqual({
    schemaVersion: 1, sourceFileId: uploaded.value.id, sourceSha256: source!.sha256, documentId: document.id,
    extractionVersionId: review.shown!.id, originExtractionRequestId: expect.any(String),
    basis: { kind: "normalized", format: "jpeg", sha256: derivative.sha256 }, range: { firstPage: 1, lastPage: 1 },
    fields: { documentNumber: { origin: "ai", originalValue: "IMAGE-240", locations: [
      { kind: "page", page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
    ] } },
  });
});

it.each(["xls", "xlsx"] as const)("loads %s absolute workbook references only from the actual sheet and Document input, remapping zero-rate rows", async (format) => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.sheet_add_aoa(sheet, [["Number", "VAT"], ["OTHER-DOC", "42.00"], ["CELL-240", "210.00"]], { origin: "D5" });
  sheet["!ref"] = "D5:E7";
  XLSX.utils.book_append_sheet(workbook, sheet, "Faktury říjen");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["OTHER-SHEET"]]), "Other");
  const sourceBytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: format }));
  let textSent = "";
  const location = { fieldPath: "documentNumber", kind: "workbook", sheetName: "Faktury říjen", firstRow: 7, lastRow: 7, firstColumn: 4, lastColumn: 4 };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const split = body.text.format.name === "ivat_split";
    if (!split) textSent = body.input[0].content[0].text;
    const output = split ? { documents: [{ sheetName: "Faktury říjen", firstRow: 7, lastRow: 7 }] } : {
      ...SAMPLE_EXTRACTION, documentNumber: "CELL-240",
      rateBreakdown: [{ rate: 12, netAmount: "0.00", vatAmount: "0.00" }, { rate: 21, netAmount: "1000.00", vatAmount: "210.00" }],
      sourceLocations: [location, { ...location, fieldPath: "rateBreakdown.1.vatAmount", firstColumn: 5, lastColumn: 5 },
        { ...location, sheetName: "Other" }, { ...location, firstRow: 6, lastRow: 6 }, { ...location, firstColumn: 1 }],
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: split ? "gpt-split" : "gpt-extract", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider stand-in did not bind");
  const provider = openAiProvider({ apiKey: "test-secret", splitModel: "gpt-split", extractModel: "gpt-extract", baseUrl: `http://127.0.0.1:${address.port}` });
  const worker = testWorker(provider);
  const admin = await administratorWithCompany();
  const configured = await assignAiConfigurationFixture(admin.client, worker.jobs, { companyId: admin.companyId, provider });
  if (!configured.ok) throw new Error(configured.error);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, { companyId: admin.companyId, fileName: `workbook-evidence.${format}`, bytes: sourceBytes });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  const source = (await getSourceFile(admin.client, admin.companyId, uploaded.value.id))!;
  const review = (await getDocumentReview(admin.client, { companyId: admin.companyId, documentId: document.id }))!;
  expect(review.sourceRows).toMatchObject({
    sheetName: "Faktury říjen", firstRow: 7, lastRow: 7,
    rows: [
      { number: 5, context: true, cells: [{ address: "D5", column: 4, text: "Number" }, { address: "E5", column: 5, text: "VAT" }] },
      { number: 7, context: false, cells: [{ address: "D7", column: 4, text: "CELL-240" }, { address: "E7", column: 5, text: "210.00" }] },
    ],
  });
  expect(await readDocumentRows(admin.client, admin.companyId, document.id, 999)).toBeNull();
  expect(textSent).toBe('[Sheet "Faktury říjen"]\n[Columns]\tD\tE\n5\tNumber\tVAT\n7\tCELL-240\t210.00');
  expect((await readSourceFile(admin.client, admin.companyId, uploaded.value.id))?.bytes).toEqual(sourceBytes);
  expect(review.shown!.payload.sourceEvidence).toEqual({
    schemaVersion: 1, sourceFileId: uploaded.value.id, sourceSha256: source.sha256, documentId: document.id,
    extractionVersionId: review.shown!.id, originExtractionRequestId: expect.any(String),
    basis: { kind: "original", format, sha256: source.sha256 },
    range: { sheetName: "Faktury říjen", firstRow: 7, lastRow: 7, firstColumn: 4, lastColumn: 5, headerRow: 5 },
    fields: {
      documentNumber: { origin: "ai", originalValue: "CELL-240", locations: [{ kind: "workbook", sheetName: "Faktury říjen", firstRow: 7, lastRow: 7, firstColumn: 4, lastColumn: 4 }] },
      "rateBreakdown.0.vatAmount": { origin: "ai", originalValue: "210.00", locations: [{ kind: "workbook", sheetName: "Faktury říjen", firstRow: 7, lastRow: 7, firstColumn: 5, lastColumn: 5 }] },
    },
  });
});

it.each(["png", "heic", "xlsx"] as const)("retains %s references with manual provenance, rejects caller-selected source identity and preserves historical AI Versions", async (format) => {
  let calls = 0;
  const worker = testWorker(fakeAiProvider({
    split: () => format === "xlsx" ? [{ sheetName: "Invoices", firstRow: 2, lastRow: 2 }] : [{ firstPage: 1, lastPage: 1 }],
    extract: () => {
      calls++;
      return { ...SAMPLE_EXTRACTION, documentNumber: `AI-${calls}`, sourceLocations: format === "xlsx"
        ? [{ fieldPath: "documentNumber", kind: "workbook", sheetName: "Invoices", firstRow: 2, lastRow: 2, firstColumn: calls, lastColumn: calls }]
        : [{ fieldPath: "documentNumber", kind: "page", page: 1, x: calls === 1 ? 0.1 : 0.5, y: 0.1, width: 0.3, height: 0.05 }],
      };
    },
  }));
  const admin = await administratorWithCompany();
  const configured = await assignAiConfigurationFixture(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
  if (!configured.ok) throw new Error(configured.error);
  const bytes = format === "heic" ? heicFixture() : format === "png" ? fixtureFile("receipt.png")
    : workbookFile("xlsx", [["First number", "Second number"], ["AI-1", "AI-2"]]);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, { companyId: admin.companyId, fileName: `history.${format}`, bytes });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  const target = { companyId: admin.companyId, documentId: document.id };
  const original = (await getDocumentReview(admin.client, target))!.shown!;
  expect(original.payload.sourceEvidence?.fields.documentNumber).toMatchObject({ origin: "ai", originalValue: "AI-1" });
  const changed = { ...original.payload, documentNumber: "MANUAL-240", sourceEvidence: { ...original.payload.sourceEvidence!, sourceFileId: crypto.randomUUID() } };
  expect(await correctDocument(admin.client, { ...target, basedOnVersion: 1, payload: changed }, undefined, fakeVatPayerRegistry()))
    .toEqual({ ok: true, value: { version: 2 } });
  const corrected = (await getDocumentReview(admin.client, target))!.shown!;
  expect(corrected.payload.sourceEvidence).toMatchObject({ sourceFileId: uploaded.value.id, extractionVersionId: corrected.id,
    fields: { documentNumber: { origin: "manual", originalValue: "AI-1", locations: original.payload.sourceEvidence!.fields.documentNumber.locations } } });
  expect(await reprocessDocument(admin.client, worker.jobs, { ...target, confirmed: true })).toEqual({ ok: true, value: null });
  expect(await worker.runJobs()).toEqual([]);
  const current = (await getDocumentReview(admin.client, target))!.shown!;
  expect(current).toMatchObject({ version: 3, payload: { documentNumber: "AI-2", sourceEvidence: { extractionVersionId: current.id,
    fields: { documentNumber: { origin: "ai", originalValue: "AI-2" } } } } });
  expect(current.payload.sourceEvidence!.fields.documentNumber.locations).not.toEqual(original.payload.sourceEvidence!.fields.documentNumber.locations);
  expect((await getDocumentReview(admin.client, { ...target, requestedVersion: "1" }))!.shown!.payload).toEqual(original.payload);
  expect((await getDocumentReview(admin.client, { ...target, requestedVersion: "2" }))!.shown!.payload).toEqual(corrected.payload);
  if (format === "xlsx") {
    const manual = await createConfirmedManualDocument(admin.client, { companyId: admin.companyId, payload: current.payload }, undefined, fakeVatPayerRegistry());
    if (!manual.ok) throw new Error(manual.error);
    const independent = (await getDocumentReview(admin.client, { companyId: admin.companyId, documentId: manual.value.id }))!;
    expect(independent.document).toMatchObject({ sourceFileId: null, importDate: null });
    expect(independent.shown!.payload).not.toHaveProperty("sourceEvidence");
    expect(independent.sourceRows).toBeNull();
  }
  expect(calls).toBe(2);
  expect((await readSourceFile(admin.client, admin.companyId, uploaded.value.id))?.bytes).toEqual(bytes);
});

it.each(["png", "xlsx"] as const)("missing %s locations remain informational and permit sound financial approval without paid backfill", async (format) => {
  let calls = 0;
  const worker = testWorker(fakeAiProvider({
    split: () => format === "xlsx" ? [{ sheetName: "Invoices", firstRow: 2, lastRow: 2 }] : [{ firstPage: 1, lastPage: 1 }],
    extract: () => { calls++; return { ...SAMPLE_EXTRACTION, sourceLocations: format === "xlsx"
      ? [{ fieldPath: "documentNumber", kind: "workbook", sheetName: "Missing", firstRow: 2, lastRow: 2, firstColumn: 1, lastColumn: 1 }]
      : [{ fieldPath: "documentNumber", kind: "page", page: 9, x: 0.1, y: 0.1, width: 0.3, height: 0.05 }] }; },
  }));
  const admin = await administratorWithCompany();
  const party = SAMPLE_EXTRACTION.supplier;
  const known = await createCounterparty(admin.client, { companyId: admin.companyId, name: party.name!, ico: party.ico, vatId: party.vatId,
    street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false });
  if (!known.ok) throw new Error(known.error);
  const configured = await assignAiConfigurationFixture(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
  if (!configured.ok) throw new Error(configured.error);
  const bytes = format === "png" ? fixtureFile("receipt.png") : workbookFile("xlsx", [["Number"], ["FV-2026-0001"]]);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, { companyId: admin.companyId, fileName: `missing.${format}`, bytes });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportFixture(uploaded.value.id);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  const target = { companyId: admin.companyId, documentId: document.id };
  const review = (await getDocumentReview(admin.client, target))!;
  expect(review.shown!.payload).not.toHaveProperty("sourceEvidence");
  expect(review.shown!.findings).toEqual([]);
  expect(await saveAndApproveDocument(admin.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: review.shown!.payload }, undefined, fakeVatPayerRegistry()))
    .toEqual({ ok: true, value: { version: 1 } });
  expect((await getDocumentReview(admin.client, target))!.document.status).toBe("approved");
  expect(calls).toBe(1);
  expect(worker.queued).toEqual([]);
});

it.each([true, false])("keeps optional source evidence truthful through eligible automatic completion (locations: %s)", async withLocations => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const admin = await administratorWithCompany();
    const party = SAMPLE_EXTRACTION.supplier;
    const known = await createCounterparty(admin.client, { companyId: admin.companyId, name: party.name!, ico: party.ico, vatId: party.vatId,
      street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false });
    if (!known.ok) throw new Error(known.error);
    let calls = 0;
    const worker = testWorker(fakeAiProvider({ extract: () => {
      calls++;
      return { ...SAMPLE_EXTRACTION, sourceLocations: withLocations
        ? [{ fieldPath: "documentNumber", kind: "page", page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.05 }] : [] };
    } }));
    const configured = await assignAiConfigurationFixture(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
    if (!configured.ok) throw new Error(configured.error);
    expect(await setCompanyAutomaticApproval(admin.client, { companyId: admin.companyId, enabled: true })).toEqual({ ok: true, value: null });
    const source = await uploadSourceFile(admin.client, worker.jobs, { companyId: admin.companyId, fileName: "automatic-source.png", bytes: fixtureFile("receipt.png") });
    if (!source.ok) throw new Error(source.error);
    await setOctoberImportFixture(source.value.id);
    expect(await worker.runJobs()).toEqual([]);
    const [document] = await listDocuments(admin.client, admin.companyId, source.value.id);
    const review = (await getDocumentReview(admin.client, { companyId: admin.companyId, documentId: document.id }))!;
    expect(review).toMatchObject({ document: { status: "approved" }, shown: { version: 1, author: { kind: "ai" } },
      approvalDecisions: [{ mode: "automatic", version: 1, actorUserId: null }] });
    expect(review.versions).toHaveLength(1);
    if (withLocations) expect(review.shown!.payload.sourceEvidence).toMatchObject({ sourceFileId: source.value.id, extractionVersionId: review.shown!.id,
      fields: { documentNumber: { origin: "ai", originalValue: "FV-2026-0001" } } });
    else expect(review.shown!.payload).not.toHaveProperty("sourceEvidence");
    expect(calls).toBe(1);
    expect(worker.queued).toEqual([]);
  });
});
