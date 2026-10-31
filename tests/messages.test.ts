import { describe, expect, it } from "vitest";
import cs from "../messages/cs.json";
import en from "../messages/en.json";
import { execFileSync } from "node:child_process";

/** Every leaf key of a messages file, as a dotted path. */
function keys(messages: object, prefix = ""): string[] {
  return Object.entries(messages).flatMap(([key, value]) =>
    typeof value === "object" && value !== null ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

describe("messages", () => {
  it("has the same keys in Czech and English", () => {
    expect(keys(cs).sort()).toEqual(keys(en).sort());
  });

  it("ships native Auth templates and subjects generated from the locale catalogs", () => {
    execFileSync(process.execPath, ["scripts/generate-auth-templates.mjs", "--check"], { stdio: "pipe" });
  });
});
