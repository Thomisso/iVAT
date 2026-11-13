import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import {
  listDocuments,
  listExtractionVersions,
  mergeDocuments,
  moveDocumentPage,
  reprocessDocument,
  splitDocument,
} from "@/application/documents";
import { uploadSourceFile } from "./support/source-upload";
import { fakeAiProvider } from "@/ai/fake";
import { provisionedUser } from "./support/clients";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
} from "./support/fixtures";
import { testWorker } from "./support/worker";
import { workbookFile } from "./support/files";

async function fourPagePdf() {
  const pdf = await PDFDocument.create();
  for (let page = 0; page < 4; page++) pdf.addPage();
  return new Uint8Array(await pdf.save());
}

async function processedFourPageFile(split?: () => { firstPage: number; lastPage: number }[]) {
  const extractedPageCounts: number[] = [];
  const worker = testWorker(
    fakeAiProvider({
      split,
      extract(input) {
        extractedPageCounts.push(input.pageCount);
        return {
          schemaVersion: 1,
          documentType: "invoice",
          documentNumber: `pages-${input.pageCount}`,
          issueDate: "2026-10-01",
          taxPointDate: "2026-10-01",
          dueDate: null,
          direction: "incoming",
          supplier: {
            name: null,
            ico: null,
            vatId: null,
            street: null,
            city: null,
            postalCode: null,
            country: null,
          },
          customer: {
            name: null,
            ico: null,
            vatId: null,
            street: null,
            city: null,
            postalCode: null,
            country: null,
          },
          currency: "CZK",
          rateBreakdown: [],
          totals: { netAmount: null, vatAmount: null, grossAmount: null },
          payment: { variableSymbol: null, bankAccount: null, iban: null },
          proposedVatRegime: "domestic",
          reverseChargeCode: null,
          originalDocumentNumber: null,
        };
      },
    }),
  );
  const admin = await administratorWithCompany();
  const enabled = await enableAiProcessing(admin.client, worker.jobs, {
    companyId: admin.companyId,
    provider: worker.ai,
  });
  if (!enabled.ok) throw new Error(enabled.error);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, {
    companyId: admin.companyId,
    fileName: "four-pages.pdf",
    bytes: await fourPagePdf(),
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await worker.runJobs();
  return { ...admin, worker, sourceFileId: uploaded.value.id, extractedPageCounts };
}

describe("Split correction", () => {
  it("refuses page correction of Excel row sets while preserving their ordinary Extraction workflow", async () => {
    const context = await administratorWithCompany();
    const worker = testWorker(fakeAiProvider({ split: () => [
      { sheetName: "Invoices", firstRow: 2, lastRow: 2 },
      { sheetName: "Invoices", firstRow: 3, lastRow: 3 },
    ] }));
    const enabled = await enableAiProcessing(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
    if (!enabled.ok) throw new Error(enabled.error);
    const uploaded = await uploadSourceFile(context.client, worker.jobs, {
      companyId: context.companyId, fileName: "invoices.xlsx",
      bytes: workbookFile("xlsx", [["Number"], ["EXCEL-1"], ["EXCEL-2"]]),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect(await worker.runJobs()).toEqual([]);
    const before = await listDocuments(context.client, context.companyId, uploaded.value.id);
    const histories = await Promise.all(before.map((document) => listExtractionVersions(context.client, context.companyId, document.id)));
    expect(await mergeDocuments(context.client, worker.jobs, {
      companyId: context.companyId, leftDocumentId: before[0].id, rightDocumentId: before[1].id,
    })).toEqual({ ok: false, error: "not_correctable" });
    const direct = await context.client.rpc("merge_documents", { left_document_id: before[0].id, right_document_id: before[1].id });
    expect(direct.error).toMatchObject({ code: "P0001", hint: "not_correctable" });
    expect(await listDocuments(context.client, context.companyId, uploaded.value.id)).toEqual(before);
    expect(await Promise.all(before.map((document) => listExtractionVersions(context.client, context.companyId, document.id)))).toEqual(histories);
    expect(worker.queued).toEqual([]);
    expect(await reprocessDocument(context.client, worker.jobs, { companyId: context.companyId, documentId: before[0].id }))
      .toEqual({ ok: true, value: null });
    expect(await worker.runJobs()).toEqual([]);
    expect((await listDocuments(context.client, context.companyId, uploaded.value.id))[0]).toMatchObject({
      status: "needs_review", hasDocumentImage: false, rowSet: { sheetName: "Invoices", firstRow: 2, lastRow: 2 },
    });
    expect(await listExtractionVersions(context.client, context.companyId, before[0].id)).toHaveLength(2);
  });

  it("merges adjacent Documents, re-extracts the result only, and keeps every earlier Extraction Version", async () => {
    const context = await processedFourPageFile();
    const before = await listDocuments(context.client, context.companyId, context.sourceFileId);
    const [first, second] = before;

    expect(
      await mergeDocuments(context.client, context.worker.jobs, {
        companyId: context.companyId,
        leftDocumentId: first.id,
        rightDocumentId: second.id,
      }),
    ).toEqual({ ok: true, value: null });

    expect(
      (await listDocuments(context.client, context.companyId, context.sourceFileId)).map((document) => [
        document.id,
        document.firstPage,
        document.lastPage,
        document.status,
      ]),
    ).toEqual([
      [first.id, 1, 2, "uploaded"],
      [before[2].id, 3, 3, "needs_review"],
      [before[3].id, 4, 4, "needs_review"],
    ]);
    expect(context.worker.queued).toEqual([{ name: "extract-document", data: { documentId: first.id } }]);
    expect(await listExtractionVersions(context.client, context.companyId, first.id)).toHaveLength(1);
    expect(await listExtractionVersions(context.client, context.companyId, second.id)).toHaveLength(1);

    await context.worker.runJobs();

    expect(
      (await listExtractionVersions(context.client, context.companyId, first.id)).map((version) => version.version),
    ).toEqual([1, 2]);
    expect(
      (await listExtractionVersions(context.client, context.companyId, second.id)).map((version) => version.version),
    ).toEqual([1]);
    expect(context.extractedPageCounts).toEqual([1, 1, 1, 1, 2]);
    expect((await listAuditEvents(context.client, context.organizationId)).at(-1)).toEqual(
      expect.objectContaining({
        action: "source_file.split_corrected",
        companyId: context.companyId,
        targetType: "source_file",
        targetId: context.sourceFileId,
        payload: {
          operation: "merge",
          affected_document_ids: [first.id],
          superseded_document_ids: [second.id],
        },
      }),
    );
  });

  it("splits a Document and re-extracts both results while preserving the original history", async () => {
    const context = await processedFourPageFile(() => [{ firstPage: 1, lastPage: 4 }]);
    const [original] = await listDocuments(context.client, context.companyId, context.sourceFileId);

    expect(
      await splitDocument(context.client, context.worker.jobs, {
        companyId: context.companyId,
        documentId: original.id,
        splitAfterPage: 2,
      }),
    ).toEqual({ ok: true, value: null });

    const [left, right] = await listDocuments(context.client, context.companyId, context.sourceFileId);
    expect(
      [left, right].map((document) => [document.id, document.firstPage, document.lastPage, document.status]),
    ).toEqual([
      [original.id, 1, 2, "uploaded"],
      [expect.any(String), 3, 4, "uploaded"],
    ]);
    expect(context.worker.queued).toEqual([
      { name: "extract-document", data: { documentId: left.id } },
      { name: "extract-document", data: { documentId: right.id } },
    ]);
    expect(await listExtractionVersions(context.client, context.companyId, left.id)).toHaveLength(1);
    expect(await listExtractionVersions(context.client, context.companyId, right.id)).toEqual([]);

    await context.worker.runJobs();

    expect((await listExtractionVersions(context.client, context.companyId, left.id)).map((v) => v.version)).toEqual([
      1, 2,
    ]);
    expect((await listExtractionVersions(context.client, context.companyId, right.id)).map((v) => v.version)).toEqual([
      1,
    ]);
    expect(context.extractedPageCounts).toEqual([4, 2, 2]);
  });

  it("moves a shared boundary page and re-extracts just the two affected Documents", async () => {
    const context = await processedFourPageFile(() => [
      { firstPage: 1, lastPage: 2 },
      { firstPage: 3, lastPage: 4 },
    ]);
    const [left, right] = await listDocuments(context.client, context.companyId, context.sourceFileId);

    expect(
      await moveDocumentPage(context.client, context.worker.jobs, {
        companyId: context.companyId,
        sourceDocumentId: left.id,
        targetDocumentId: right.id,
        page: 2,
      }),
    ).toEqual({ ok: true, value: null });

    expect(
      (await listDocuments(context.client, context.companyId, context.sourceFileId)).map((document) => [
        document.id,
        document.firstPage,
        document.lastPage,
        document.status,
      ]),
    ).toEqual([
      [left.id, 1, 1, "uploaded"],
      [right.id, 2, 4, "uploaded"],
    ]);
    expect(context.worker.queued).toEqual([
      { name: "extract-document", data: { documentId: left.id } },
      { name: "extract-document", data: { documentId: right.id } },
    ]);

    await context.worker.runJobs();

    expect((await listExtractionVersions(context.client, context.companyId, left.id)).map((v) => v.version)).toEqual([
      1, 2,
    ]);
    expect((await listExtractionVersions(context.client, context.companyId, right.id)).map((v) => v.version)).toEqual([
      1, 2,
    ]);
    expect(context.extractedPageCounts).toEqual([2, 2, 1, 3]);
  });

  it("refuses a non-adjacent correction and a User from another Organization", async () => {
    const context = await processedFourPageFile();
    const documents = await listDocuments(context.client, context.companyId, context.sourceFileId);
    const outsider = await provisionedUser("Other Organization");

    expect(
      await mergeDocuments(context.client, context.worker.jobs, {
        companyId: context.companyId,
        leftDocumentId: documents[0].id,
        rightDocumentId: documents[2].id,
      }),
    ).toEqual({ ok: false, error: "invalid_split_boundary" });
    expect(
      await mergeDocuments(outsider.client, context.worker.jobs, {
        companyId: context.companyId,
        leftDocumentId: documents[0].id,
        rightDocumentId: documents[1].id,
      }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(context.worker.queued).toEqual([]);
    expect(
      (await listDocuments(context.client, context.companyId, context.sourceFileId)).map((document) => [
        document.firstPage,
        document.lastPage,
      ]),
    ).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
  });
});
