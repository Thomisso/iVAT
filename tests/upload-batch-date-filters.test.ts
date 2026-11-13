import { describe, expect, it } from "vitest";
import { beginUploadBatch, finishUploadBatch, listUploadBatches } from "@/application/upload-batches";
import { administratorWithCompany, assignAiConfigurationFixture, setUploadBatchCreationDatesFixture } from "./support/fixtures";
import { listCompanyDocuments } from "@/application/documents";
import { uploadSourceFile } from "./support/source-upload";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { fixtureFile, selectFixtureFiles } from "./support/files";
import { testWorker } from "./support/worker";

describe("Upload Batch creation-date filters", () => {
  it("accepts a future final calendar day and safely ignores impossible calendar ranges", async () => {
    const { client, companyId } = await administratorWithCompany();
    const batch = await beginUploadBatch(client, { companyId, fileCount: 1, selectedFiles: selectFixtureFiles("receipt.png").selectedFiles });
    if (!batch.ok) throw new Error(batch.error);
    expect((await listUploadBatches(client, companyId, { createdTo: "9999-12-31" })).map((entry) => entry.id)).toEqual([batch.value.id]);
    expect(await listUploadBatches(client, companyId, { createdFrom: "0000-01-01" })).toEqual([]);
  });
  it.each([
    ["2026-03-29", "2026-03-28T22:59:59.999Z", "2026-03-28T23:00:00.000Z", "2026-03-29T21:59:59.999Z", "2026-03-29T22:00:00.000Z"],
    ["2026-10-25", "2026-10-24T21:59:59.999Z", "2026-10-24T22:00:00.000Z", "2026-10-25T22:59:59.999Z", "2026-10-25T23:00:00.000Z"],
  ])("includes both endpoint days across the Prague clock change on %s", async (day, before, first, last, after) => {
    const { client, companyId } = await administratorWithCompany();
    const ids: string[] = [];
    for (const createdAt of [before, first, last, after]) {
      const batch = await beginUploadBatch(client, { companyId, fileCount: 1, selectedFiles: selectFixtureFiles("receipt.png").selectedFiles });
      if (!batch.ok) throw new Error(batch.error);
      ids.push(batch.value.id);
      await setUploadBatchCreationDatesFixture([{ batchId: batch.value.id, createdAt }]);
    }
    const selected = async (options: Parameters<typeof listUploadBatches>[2]) =>
      (await listUploadBatches(client, companyId, options)).map((batch) => batch.id);
    expect(await selected({ createdFrom: day, createdTo: day })).toEqual([ids[2], ids[1]]);
    expect(await selected({ createdFrom: day })).toEqual([ids[3], ids[2], ids[1]]);
    expect(await selected({ createdTo: day })).toEqual([ids[2], ids[1], ids[0]]);
    expect(await selected({ createdFrom: "", createdTo: "" })).toEqual([ids[3], ids[2], ids[1], ids[0]]);
    expect(await selected({ createdFrom: day, createdTo: day, limit: 1, offset: 1 })).toEqual([ids[1]]);
  });

  it("uses creation only for a mixed-Reporting-Period batch and retains Document period filters", async () => {
    const { client, companyId } = await administratorWithCompany();
    const dates = ["2026-03-10", "2026-04-02"];
    const worker = testWorker(fakeAiProvider({ extract: () => {
      const date = dates.shift()!;
      return { ...SAMPLE_EXTRACTION, documentNumber: date, direction: "outgoing", issueDate: date, taxPointDate: date, dueDate: date,
        supplier: SAMPLE_EXTRACTION.customer, customer: SAMPLE_EXTRACTION.supplier };
    } }));
    await assignAiConfigurationFixture(client, worker.jobs, { companyId, provider: worker.ai });
    const selection = selectFixtureFiles("two-invoices.pdf");
    const batch = await beginUploadBatch(client, { companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(client, worker.jobs, { companyId, batchId: batch.value.id, sourceFileId: selection.files[0].sourceFileId, fileName: "mixed.pdf", bytes: fixtureFile("two-invoices.pdf") });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await finishUploadBatch(client, batch.value.id);
    expect(await worker.runJobs()).toEqual([]);
    await setUploadBatchCreationDatesFixture([{ batchId: batch.value.id, createdAt: "2026-03-29T10:00:00.000Z" }]);
    expect((await listUploadBatches(client, companyId, { createdFrom: "2026-03-29", createdTo: "2026-03-29" })).map((entry) => entry.id)).toEqual([batch.value.id]);
    expect(await listUploadBatches(client, companyId, { createdFrom: "2026-04-01", createdTo: "2026-04-30" })).toEqual([]);
    expect((await listCompanyDocuments(client, companyId, { reportingPeriod: "2026-03" })).map((document) => document.taxPointDate)).toEqual(["2026-03-10"]);
    expect((await listCompanyDocuments(client, companyId, { reportingPeriod: "2026-04" })).map((document) => document.taxPointDate)).toEqual(["2026-04-02"]);
    expect(await listUploadBatches(client, companyId, { createdFrom: "2026-02-30" })).toEqual([]);
    expect(await listUploadBatches(client, companyId, { createdFrom: "2026-04-30", createdTo: "2026-04-01" })).toEqual([]);
    const other = await administratorWithCompany();
    expect(await listUploadBatches(other.client, companyId, { createdFrom: "2026-03-29", createdTo: "2026-03-29" })).toEqual([]);
  });
});
