import { sourceEvidencePdfFixture } from "../support/source-evidence";
import { expect, it } from "vitest";
import { openAiProvider } from "@/ai/openai";

const simulation = process.env.OPENAI_SIMULATION_BASE_URL ? it : it.skip;

simulation("runs native Split and rasterized PDF Extraction through the OpenAI HTTP simulation", async () => {
  const provider = openAiProvider({
    apiKey: "simulation-secret",
    splitModel: "gpt-split",
    extractModel: "gpt-extract",
    baseUrl: process.env.OPENAI_SIMULATION_BASE_URL,
  });

  await expect(provider.split({
    format: "pdf",
    mediaType: "application/pdf",
    bytes: new Uint8Array([37, 80, 68, 70]),
    pageCount: 1,
  })).resolves.toEqual({ model: "gpt-split", documents: [{ firstPage: 1, lastPage: 1 }] });
  await expect(provider.extract({
    format: "pdf",
    mediaType: "application/pdf",
    bytes: await sourceEvidencePdfFixture(),
    pageCount: 3,
  })).resolves.toEqual(expect.objectContaining({
    model: "gpt-extract",
    payload: expect.objectContaining({ schemaVersion: 1, documentNumber: "SIM-1" }),
  }));
});
