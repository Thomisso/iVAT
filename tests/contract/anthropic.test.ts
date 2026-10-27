import { expect, it } from "vitest";
import { anthropicAiProvider } from "@/ai/anthropic";
import { fixtureFile } from "../support/files";

const contract = process.env.ANTHROPIC_CONTRACT_TEST === "1" ? it : it.skip;

contract("extracts a Document through the live Anthropic Messages API", async () => {
  const apiKey = process.env.ANTHROPIC_CONTRACT_API_KEY;
  const model = process.env.ANTHROPIC_CONTRACT_MODEL;
  if (!apiKey || !model) {
    throw new Error("Set ANTHROPIC_CONTRACT_API_KEY and ANTHROPIC_CONTRACT_MODEL to run this contract test");
  }
  const provider = anthropicAiProvider({ apiKey, splitModel: model, extractModel: model });

  const result = await provider.extract({
    format: "png",
    mediaType: "image/png",
    bytes: fixtureFile("receipt.png"),
    pageCount: 1,
  });

  expect(result.model).toBeTruthy();
  expect(result.payload).toEqual(expect.objectContaining({
    schemaVersion: 1,
    rateBreakdown: expect.any(Array),
    supplier: expect.any(Object),
    customer: expect.any(Object),
  }));
});
