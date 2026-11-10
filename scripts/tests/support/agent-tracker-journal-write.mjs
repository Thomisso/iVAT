// Hold a real temporary journal write halfway through; committed files still
// use the production fsync/rename sequence. Only the filesystem boundary varies.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const gate = new URL(import.meta.url).searchParams.get("gate");
const nativeOpen = fs.openSync;
const nativeWrite = fs.writeFileSync;
const descriptors = new Map();
fs.openSync = (file, ...options) => {
  const descriptor = nativeOpen(file, ...options);
  if (typeof file === "string" && file.endsWith(".tmp")) descriptors.set(descriptor, file);
  return descriptor;
};
let gated = false;
fs.writeFileSync = (file, data, ...options) => {
  if (gated || !descriptors.has(file) || !fs.existsSync(path.join(gate, "arm"))) return nativeWrite(file, data, ...options);
  gated = true;
  const midpoint = Math.floor(data.length / 2);
  nativeWrite(file, data.slice(0, midpoint), ...options);
  nativeWrite(path.join(gate, "ready"), "");
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(gate, "release"))) {
    if (Date.now() > deadline) throw new Error("Journal fixture gate timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return nativeWrite(file, data.slice(midpoint), ...options);
};
syncBuiltinESMExports();
