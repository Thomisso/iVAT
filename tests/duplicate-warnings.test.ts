import { describe, expect, it } from "vitest";
import { approveDocument, listDocuments, listDuplicateWarnings } from "@/application/documents";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { enableAiProcessing } from "@/application/companies";
import { uploadSourceFile } from "@/application/source-files";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { fixtureFile } from "./support/files";
import { administratorWithCompany } from "./support/fixtures";
import { testWorker } from "./support/worker";

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
});
