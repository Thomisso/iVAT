import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const systemClientSource = `
  import { asSystemClient } from "@/application/client";
  export const client = asSystemClient(null as never);
`;

async function messagesFor(filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(systemClientSource, { filePath });
  return result.messages.map((message) => message.message);
}

describe("SystemClient construction lint guardrail", () => {
  it("rejects construction in application code", async () => {
    expect(await messagesFor("src/application/example.ts")).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Only worker/index.ts and tests/support/worker.ts construct a SystemClient (ADR-0010).",
        ),
      ]),
    );
  });

  it("allows construction at the worker entrypoint", async () => {
    expect(await messagesFor("worker/index.ts")).not.toEqual(
      expect.arrayContaining([expect.stringContaining("construct a SystemClient")]),
    );
  });

  it("allows construction in worker test support", async () => {
    expect(await messagesFor("tests/support/worker.ts")).not.toEqual(
      expect.arrayContaining([expect.stringContaining("construct a SystemClient")]),
    );
  });
});
