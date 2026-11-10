// Stretch one native fixture write across a reader, without replacing CLI or Git behavior.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const settings = new URL(import.meta.url).searchParams;
const gate = settings.get("gate");
const mode = settings.get("mode") ?? "write";
const remote = process.env.TRACKER_FAKE_GITHUB;
const nativeWriteFileSync = fs.writeFileSync;
const nativeReadFileSync = fs.readFileSync;
function waitForRelease() {
  nativeWriteFileSync(path.join(gate, "ready"), "");
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(gate, "release"))) {
    if (Date.now() > deadline) throw new Error("Fixture publication gate timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
fs.readFileSync = (file, ...options) => {
  const snapshot = nativeReadFileSync(file, ...options);
  if (mode !== "read" || file !== remote || !process.argv.includes("repos/example/project/issues/99/comments?per_page=100&page=1") || !fs.existsSync(path.join(gate, "arm"))) return snapshot;
  try { fs.mkdirSync(path.join(gate, "reader")); }
  catch (error) { if (error.code === "EEXIST") return snapshot; throw error; }
  waitForRelease();
  return snapshot;
};
let gated = false;
fs.writeFileSync = (file, data, ...options) => {
  const fixtureFile = mode === "write" && typeof file === "string" && path.dirname(file) === path.dirname(remote) && path.basename(file).startsWith(path.basename(remote));
  const dispatches = fixtureFile && typeof data === "string" ? JSON.parse(data).dispatches : null;
  if (gated || !dispatches || dispatches.length !== 2 || JSON.parse(dispatches.at(-1)).type !== "claim") return nativeWriteFileSync(file, data, ...options);
  gated = true;
  const midpoint = Math.floor(data.length / 2);
  nativeWriteFileSync(file, data.slice(0, midpoint), ...options);
  waitForRelease();
  const descriptor = fs.openSync(file, "a");
  try { fs.writeSync(descriptor, data.slice(midpoint)); }
  finally { fs.closeSync(descriptor); }
};
syncBuiltinESMExports();
