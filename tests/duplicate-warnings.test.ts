import { describe, expect, it } from "vitest";
import { approveDocument, listCompanyDocuments, listDocuments, listDuplicateWarnings } from "@/application/documents";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { uploadSourceFile } from "@/application/source-files";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { fixtureFile } from "./support/files";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
  companyWithManyReportDocuments,
} from "./support/fixtures";
import { testWorker } from "./support/worker";
import { duplicateWarningCompanyAccessChecks } from "./support/duplicate-warning-query";

async function companyWithExtractions(...extractions: ExtractionPayload[]) {
  let extraction = 0;
  const worker = testWorker(fakeAiProvider({ extract: () => extractions[extraction++] }));
  const admin = await administratorWithCompany();
  const enabled = await enableAiProcessing(admin.client, worker.jobs, {
    companyId: admin.companyId,
    provider: worker.ai,
  });
  if (!enabled.ok) throw new Error(enabled.error);

  async function upload(fixture: "receipt.png" | "receipt.jpg") {
    const result = await uploadSourceFile(admin.client, worker.jobs, {
      companyId: admin.companyId,
      fileName: fixture,
      bytes: fixtureFile(fixture),
    });
    if (!result.ok) throw new Error(result.error);
    await worker.runJobs();
    const [document] = await listDocuments(admin.client, admin.companyId, result.value.id);
    return document;
  }

  return { ...admin, upload };
}

describe("Duplicate Warnings", () => {
  it("links a later Document with the same counterparty VAT ID, number and Direction to the existing Document", async () => {
    const company = await companyWithExtractions(SAMPLE_EXTRACTION, SAMPLE_EXTRACTION);
    const existing = await company.upload("receipt.png");
    const duplicate = await company.upload("receipt.jpg");

    expect(await listDuplicateWarnings(company.client, company.companyId, existing.id)).toEqual([]);
    expect(await listDuplicateWarnings(company.client, company.companyId, duplicate.id)).toEqual([
      {
        kind: "document_identity",
        matchedDocumentId: existing.id,
      },
    ]);
  });

  it("warns on a repeated Source File hash without blocking approval", async () => {
    const differentInvoice = {
      ...SAMPLE_EXTRACTION,
      documentNumber: "FV-2026-0002",
      supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: "CZ45274649" },
    };
    const company = await companyWithExtractions(SAMPLE_EXTRACTION, differentInvoice);
    const existing = await company.upload("receipt.png");
    const duplicate = await company.upload("receipt.png");

    expect(await listDuplicateWarnings(company.client, company.companyId, duplicate.id)).toEqual([
      {
        kind: "source_file_hash",
        matchedDocumentId: existing.id,
      },
    ]);
    expect(
      await approveDocument(company.client, {
        companyId: company.companyId,
        documentId: duplicate.id,
        version: 1,
      }),
    ).toEqual({ ok: true, value: null });
    expect((await listDocuments(company.client, company.companyId, duplicate.sourceFileId))[0].status).toBe("approved");
  });

  it("does not reveal a matching Document from another Company", async () => {
    const a = await companyWithExtractions(SAMPLE_EXTRACTION);
    const b = await companyWithExtractions(SAMPLE_EXTRACTION);
    await a.upload("receipt.png");
    const document = await b.upload("receipt.png");

    expect(await listDuplicateWarnings(b.client, b.companyId, document.id)).toEqual([]);
    expect(await listDuplicateWarnings(a.client, b.companyId, document.id)).toEqual([]);
  });

  it("keeps native warning lookup work scoped to the Company instead of expanding foreign current Documents", async () => {
    const company = await companyWithExtractions(SAMPLE_EXTRACTION, SAMPLE_EXTRACTION);
    const existing = await company.upload("receipt.png");
    const duplicate = await company.upload("receipt.jpg");
    const foreign = await companyWithManyReportDocuments(32);
    expect(await listCompanyDocuments(foreign.client, foreign.companyId)).toHaveLength(32);

    expect(await listDuplicateWarnings(company.client, company.companyId, duplicate.id)).toEqual([
      { kind: "document_identity", matchedDocumentId: existing.id },
    ]);
    expect(await listDuplicateWarnings(foreign.client, company.companyId, duplicate.id)).toEqual([]);
    // Timing hid this regression on a fast developer machine. Observe the same
    // real native-session read's database work as well as its App output above.
    // The old global CTE checks at least all 34 Documents; the scoped plan uses
    // only a handful. Leave generous headroom without depending on an index name.
    expect(await duplicateWarningCompanyAccessChecks(company.client, company.companyId, duplicate.id))
      .toBeLessThan(16);
  });
});
