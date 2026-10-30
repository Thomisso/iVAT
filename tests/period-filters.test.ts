import { describe, expect, it } from "vitest";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { listCompanyDocuments } from "@/application/documents";
import { NO_REPORTING_PERIOD } from "@/application/reporting-periods";
import { uploadSourceFile } from "@/application/source-files";
import { beginUploadBatch, finishUploadBatch, listUploadBatches } from "@/application/upload-batches";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
} from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";

/** A Company with Reporting Year 2026 (monthly) and one Upload Batch per outgoing Document's Tax Point Date. */
async function companyWithBatchesByTaxPointDate(taxPointDates: string[]) {
  const company = await administratorWithCompany();
  const pending = [...taxPointDates];
  const worker = testWorker(fakeAiProvider({
    extract: () => {
      const taxPointDate = pending.shift()!;
      return {
        ...SAMPLE_EXTRACTION,
        documentNumber: `FV-${taxPointDate}`,
        direction: "outgoing",
        issueDate: taxPointDate,
        taxPointDate,
        dueDate: taxPointDate,
        customer: SAMPLE_EXTRACTION.supplier,
        supplier: { ...SAMPLE_EXTRACTION.customer },
      };
    },
  }));
  await enableAiProcessing(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const batchByDate: Record<string, string> = {};
  for (const date of taxPointDates) {
    const batch = await beginUploadBatch(company.client, { companyId: company.companyId, fileCount: 1 });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      batchId: batch.value.id,
      fileName: `${date}.png`,
      bytes: fixtureFile("receipt.png"),
      preselectedDirection: "outgoing",
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await finishUploadBatch(company.client, batch.value.id);
    await worker.runJobs();
    batchByDate[date] = batch.value.id;
  }
  return { ...company, batchByDate };
}

const taxPointDates = async (documents: ReturnType<typeof listCompanyDocuments>) =>
  (await documents).map((document) => document.taxPointDate).toSorted();

describe("Reporting Period filters", () => {
  it("filters Documents by a Reporting Period and by No period", async () => {
    const { client, companyId } = await companyWithBatchesByTaxPointDate(["2026-03-10", "2026-04-02", "2025-12-01"]);

    expect(await taxPointDates(listCompanyDocuments(client, companyId, { reportingPeriod: "2026-03" })))
      .toEqual(["2026-03-10"]);
    expect(await taxPointDates(listCompanyDocuments(client, companyId, { reportingPeriod: NO_REPORTING_PERIOD })))
      .toEqual(["2025-12-01"]);
  });

  it("filters Upload Batches to those containing Documents of a Reporting Period or of No period", async () => {
    const { client, companyId, batchByDate } = await companyWithBatchesByTaxPointDate(["2026-03-10", "2026-04-02", "2025-12-01"]);
    const emptyBatch = await beginUploadBatch(client, { companyId, fileCount: 1 });
    if (!emptyBatch.ok) throw new Error(emptyBatch.error);

    const batchIds = async (reportingPeriod?: string) =>
      (await listUploadBatches(client, companyId, { reportingPeriod })).map((batch) => batch.id);

    expect(await batchIds("2026-04")).toEqual([batchByDate["2026-04-02"]]);
    expect(await batchIds(NO_REPORTING_PERIOD)).toEqual([batchByDate["2025-12-01"]]);
    expect(await batchIds("2026-05")).toEqual([]);
    expect(await batchIds()).toHaveLength(4);
  });
});
