import { writeFileSync } from "node:fs";
import { sourceEvidencePdfFixture } from "./support/source-evidence";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { openAiProvider } from "@/ai/openai";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { getDocumentReview } from "@/application/document-review";
import { listDocuments } from "@/application/documents";
import { getSourceFile, uploadSourceFile } from "@/application/source-files";
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
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, {
    companyId: admin.companyId, fileName: "evidence-three-pages.pdf", bytes: await sourceEvidencePdfFixture(),
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const documents = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  const second = documents.find((document) => document.firstPage === 2);
  if (!second) throw new Error("Second Document missing");
  const source = await getSourceFile(admin.client, admin.companyId, uploaded.value.id);
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
          locations: [{ kind: "page", page: 2, x: 0.1, y: 0.1, width: 0.3, height: 0.05 }],
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
  expect(extractionRequests).toHaveLength(2);
  expect(extractionRequests[1]).toMatchObject({
    text: { format: { schema: { required: expect.arrayContaining(["sourceLocations"]), properties: { sourceLocations: { type: "array" } } } } },
  });
});
