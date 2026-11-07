// Test-only OS boundaries and native filesystem scheduling for real CLI recovery commands.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const settingsFile = new URL(import.meta.url).searchParams.get("fixture");
const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
os.hostname = () => settings.hostname;
os.platform = () => settings.platform;
const systemExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => {
  if (command !== "/usr/sbin/scutil") return systemExecFileSync(command, args, options);
  if (JSON.stringify(args) !== '["--get","LocalHostName"]' || options?.encoding !== "utf8" || !(options.timeout > 0 && options.timeout <= 1000) || !(options.maxBuffer > 0 && options.maxBuffer <= 256)) throw new Error("Unbounded or unexpected OS identity request");
  if (settings.gate) {
    fs.writeFileSync(`${settingsFile}.${process.pid}.ready`, "");
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(`${settingsFile}.release`)) {
      if (Date.now() > deadline) throw new Error("OS identity test gate timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (settings.unavailable) throw new Error("OS identity unavailable");
  return settings.localHostName;
};
if (settings.retirementGate) {
  const nativeMkdirSync = fs.mkdirSync;
  const nativeRenameSync = fs.renameSync;
  const waitForFile = file => {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(file)) {
      if (Date.now() > deadline) throw new Error("Native filesystem test gate timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };
  fs.mkdirSync = (directory, ...args) => {
    if (settings.lock && directory === path.join(settings.lock, "recovery")) {
      try { nativeMkdirSync(`${settingsFile}.elected`); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        waitForFile(`${settingsFile}.retired`);
      }
    }
    return nativeMkdirSync(directory, ...args);
  };
  fs.renameSync = (from, to) => {
    const result = nativeRenameSync(from, to);
    if (from === settings.lock) {
      fs.writeFileSync(`${settingsFile}.retired`, "");
      waitForFile(`${settingsFile}.continue`);
    }
    return result;
  };
}
syncBuiltinESMExports();
