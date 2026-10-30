import { mkdirSync, writeFileSync } from "node:fs";

// Only explicit build inputs are accepted. Runtime environment and package
// versions cannot relabel the application after this file has been compiled.
const [tag = "", revision = "", ...extra] = process.argv.slice(2);
if (extra.length || ((tag || revision) &&
    (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) || !/^[a-f0-9]{40}$/.test(revision)))) {
  throw new Error("Invalid release build identity.");
}
mkdirSync("src/lib", { recursive: true });
writeFileSync("src/lib/build-identity.json", JSON.stringify(tag ? { tag, revision } : null, null, 2) + "\n");
