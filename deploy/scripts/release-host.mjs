import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseEnv } from "node:util";
import { createGunzip } from "node:zlib";
import { validateReleaseBundle } from "./release-bundle.mjs";

async function preflight(bundle, stack) {
  const manifest = await validateReleaseBundle(bundle);
  const backups = path.join(stack, "deploy/backups");
  let archives;
  try { archives = (await readdir(backups)).filter(name => /^ivat-\d{8}T\d{6}Z\.tar\.gz$/.test(name)).sort(); }
  catch { throw new Error("No completed daily backup; inspect daily.log before releasing."); }
  if (!archives.length) throw new Error("No completed daily backup; inspect daily.log before releasing.");
  const archive = path.join(backups, archives.at(-1));
  const info = await stat(archive);
  if (Date.now() - info.mtimeMs > 26 * 3600000) throw new Error("Latest daily backup is older than 26 hours; inspect daily.log.");
  if (info.mtimeMs > Date.now() + 300000) throw new Error("Latest daily backup has a future timestamp; check the host clock.");
  let inventory;
  try { inventory = JSON.parse(await readFile(archive + ".images.json", "utf8")); }
  catch { throw new Error("Latest daily backup is missing a valid image inventory."); }
  if (!Array.isArray(inventory) || !inventory.length || inventory.some(item => !item || typeof item !== "object" || !/^sha256:[a-f0-9]{64}$/.test(item.ID || item.ImageID || ""))) {
    throw new Error("Latest daily backup has an invalid image inventory.");
  }
  try { await pipeline(createReadStream(archive), createGunzip(), new Writable({ write(_chunk, _encoding, callback) { callback(); } })); }
  catch { throw new Error("Latest daily backup is corrupt; inspect daily.log before releasing."); }
  const env = parseEnv(await readFile(path.join(stack, ".env"), "utf8"));
  if (env.SUPABASE_PUBLIC_URL !== manifest.publicBuild.supabaseUrl || env.ANON_KEY !== manifest.publicBuild.publishableKey) {
    throw new Error("Release public build settings do not match the installation environment.");
  }
  return { manifest, archive: path.basename(archive) };
}

async function synchronize(bundle, stack, attempt) {
  const manifest = await validateReleaseBundle(bundle);
  if (!/^deploy\/attempts\/[a-zA-Z0-9._-]+$/.test(attempt)) throw new Error("Invalid deployment attempt directory.");
  if (!process.env.ROSTI_API_KEY) throw new Error("Rošti API credentials are required.");
  const base = process.env.ROSTI_API_URL || "https://admin.rosti.cz/api-n";
  const parsed = new URL(base);
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "host.docker.internal"].includes(parsed.hostname)) throw new Error("Rošti API requires HTTPS.");
  const endpoint = `${base}/7895/stacks/931`;
  const duration = Number(process.env.ROSTI_TIMEOUT_MS || 15000);
  if (!Number.isInteger(duration) || duration < 1 || duration > 60000) throw new Error("Invalid Rošti timeout.");
  async function request(suffix, options = {}) {
    let response;
    try { response = await fetch(endpoint + suffix, { ...options, headers: { "X-API-Key": process.env.ROSTI_API_KEY, ...options.headers }, signal: AbortSignal.timeout(duration) }); }
    catch { throw new Error("Rošti request failed or timed out; inspect the attempt before recovery."); }
    if (!response.ok) throw new Error(`Rošti rejected Compose synchronization (HTTP ${response.status}).`);
    try { return await response.json(); } catch { throw new Error("Rošti returned an invalid response."); }
  }
  const before = await request("");
  if (typeof before.compose_b64 !== "string") throw new Error("Rošti did not return stored Compose.");
  try { await writeFile(path.join(stack, attempt, "provider-compose-before.yml"), Buffer.from(before.compose_b64, "base64"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw new Error("Cannot retain the previous provider Compose."); }
  const compose = await readFile(path.join(bundle, "docker-compose.rosti.yml"), "utf8");
  const result = await request("/compose?call_up=false", { method: "PUT", headers: { "Content-Type": "text/plain" }, body: compose });
  if (result.status != null && result.status !== 0) throw new Error("Rošti reported an unsuccessful Compose update.");
  const after = await request("");
  if (typeof after.compose_b64 !== "string" || Buffer.from(after.compose_b64, "base64").toString() !== compose) throw new Error("Rošti stored Compose does not match the release.");
  console.log(`Rošti stored Compose verified for ${manifest.revision}.`);
}

async function probe(stack) {
  const env = parseEnv(await readFile(path.join(stack, ".env"), "utf8"));
  const production = new URL(env.APP_ORIGIN);
  if (production.protocol !== "https:") throw new Error("Public application origin requires HTTPS.");
  const overridden = process.env.IVAT_DEPLOY_PUBLIC_URL;
  if (overridden && process.env.IVAT_DISPOSABLE_DEPLOYMENT !== "1") throw new Error("Public probe overrides require a disposable installation.");
  const endpoint = overridden || new URL("/login", production).href;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(endpoint, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { Host: production.host, "X-Forwarded-Proto": "https" } });
      if (response.status === 200) { console.log("Public application probe succeeded."); return; }
    } catch { /* retry bounded public availability checks without response bodies */ }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Public application probe failed; inspect the attempt before joint recovery.");
}

async function record(bundle, stack, attempt) {
  const manifest = await validateReleaseBundle(bundle);
  if (!/^deploy\/attempts\/[a-zA-Z0-9._-]+$/.test(attempt)) throw new Error("Invalid deployment attempt directory.");
  const inventory = JSON.parse(await readFile(path.join(stack, attempt, "images-after.json"), "utf8"));
  const verified = { ...manifest, deployedAt: new Date().toISOString(), attempt, selectedImages: inventory };
  const suffix = path.basename(attempt);
  const files = {
    "release-commit.txt": manifest.revision + "\n",
    "release-images.txt": JSON.stringify(inventory, null, 2) + "\n",
    "verified-release.json": JSON.stringify(verified, null, 2) + "\n",
  };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(stack, "deploy", `${name}.${suffix}.next`), content, { flag: "wx", mode: 0o600 });
  // The JSON record is authoritative and is atomically published last.
  for (const name of Object.keys(files)) await rename(path.join(stack, "deploy", `${name}.${suffix}.next`), path.join(stack, "deploy", name));
}

const [command, bundle, stack, attempt] = process.argv.slice(2);
try {
  if (command === "preflight") {
    const { manifest, archive } = await preflight(bundle, stack);
    console.log([manifest.revision, ...["app", "db", "gateway", "proxy"].map(name => manifest.images[name]), archive].join("\n"));
  } else if (command === "sync") await synchronize(bundle, stack, attempt);
  else if (command === "probe") await probe(stack);
  else if (command === "record") await record(bundle, stack, attempt);
  else throw new Error("Unknown release helper command.");
} catch (error) { console.error(error.message); process.exitCode = 1; }
