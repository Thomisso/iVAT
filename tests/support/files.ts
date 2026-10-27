import fs from "node:fs";
import path from "node:path";

/** The bytes of a file in `tests/fixtures/`. */
export function fixtureFile(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "fixtures", name)));
}
