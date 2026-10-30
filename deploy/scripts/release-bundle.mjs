import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const IMAGE_SERVICES = { app: ["web", "worker", "migrate", "backup"], db: ["db"], gateway: ["gateway"], proxy: ["proxy"] };
const REQUIRED_ASSETS = ["docker-compose.rosti.yml", "deploy/restore.yml", "deploy/scripts/migrate.mjs", "deploy/scripts/backup.sh", "deploy/scripts/backup-daily.sh", "deploy/scripts/restore.sh", "deploy/scripts/release-bundle.mjs", "deploy/scripts/deploy-release.sh", "deploy/scripts/release-host.mjs", "deploy/scripts/launch-release.sh"];
const sha256 = value => createHash("sha256").update(value).digest("hex");
const assetPath = name => name === "docker-compose.rosti.yml" || name === "deploy/restore.yml" || /^deploy\/scripts\/[a-z0-9][a-z0-9._-]*\.(mjs|sh)$/.test(name);

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function assertReleaseManifest(manifest) {
  if (!exactKeys(manifest, ["schemaVersion", "repository", "revision", "tag", "releaseId", "publicBuild", "images", "files"]) ||
      manifest.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(manifest.repository) ||
      !/^[a-f0-9]{40}$/.test(manifest.revision) || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.tag) ||
      !Number.isSafeInteger(manifest.releaseId) || manifest.releaseId <= 0) throw new Error("Invalid release manifest identity.");
  if (!exactKeys(manifest.images, Object.keys(IMAGE_SERVICES))) throw new Error("Release requires all four image digests.");
  for (const [name, image] of Object.entries(manifest.images)) {
    const prefix = `ghcr.io/${manifest.repository}/${name}@sha256:`;
    if (typeof image !== "string" || !image.startsWith(prefix) ||
        !/^[a-f0-9]{64}$/.test(image.slice(prefix.length))) throw new Error(`Invalid immutable image reference: ${name}.`);
  }
  assertPublicBuild(manifest.publicBuild);
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new Error("Invalid release asset inventory.");
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!assetPath(name) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid release asset: ${name}.`);
  }
  for (const name of REQUIRED_ASSETS) if (!manifest.files[name]) throw new Error(`Missing required release asset: ${name}.`);
  return manifest;
}

export function assertPublicBuild(publicBuild) {
  if (!exactKeys(publicBuild, ["supabaseUrl", "publishableKey"])) throw new Error("Invalid public build configuration.");
  let url;
  try { url = new URL(publicBuild.supabaseUrl); } catch { throw new Error("Invalid public Supabase URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Public Supabase URL must be an HTTPS origin.");
  }
  const key = publicBuild.publishableKey;
  let isPublicKey = typeof key === "string" && /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!isPublicKey && typeof key === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    try { isPublicKey = JSON.parse(Buffer.from(key.split(".")[1], "base64url")).role === "anon"; } catch { /* invalid JWT */ }
  }
  if (!isPublicKey) throw new Error("Build requires a public publishable/anon key, never a private service key.");
}

async function listFiles(directory, prefix = "") {
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Symbolic links are not permitted in release bundles.");
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error("Symbolic links are not permitted in release bundles.");
    if (item.isDirectory()) {
      if (!["deploy", "deploy/scripts"].includes(relative)) throw new Error(`Unexpected release asset: ${relative}.`);
      result.push(...await listFiles(path.join(directory, item.name), `${relative}/`));
    } else if (item.isFile()) result.push(relative);
    else throw new Error(`Unexpected release asset: ${relative}.`);
  }
  return result.sort();
}

export async function validateReleaseBundle(directory) {
  const files = await listFiles(directory);
  const manifest = assertReleaseManifest(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")));
  for (const name of files) {
    if (name === "manifest.json") continue;
    if (!manifest.files[name]) throw new Error(`Unexpected release asset: ${name}.`);
    if (sha256(await readFile(path.join(directory, name))) !== manifest.files[name]) throw new Error(`Release asset checksum failed: ${name}.`);
  }
  for (const name of Object.keys(manifest.files)) if (!files.includes(name)) throw new Error(`Missing release asset: ${name}.`);
  const compose = JSON.parse(await readFile(path.join(directory, "docker-compose.rosti.yml"), "utf8"));
  if (compose.name || !compose.services) throw new Error("Release Compose must preserve the host project identity.");
  for (const [image, services] of Object.entries(IMAGE_SERVICES)) {
    for (const service of services) {
      if (compose.services[service]?.image !== manifest.images[image] || compose.services[service].build) {
        throw new Error(`Release Compose image does not match manifest: ${service}.`);
      }
    }
  }
  return manifest;
}

export async function createReleaseBundle({ sourceDirectory, outputDirectory, release, publicBuild, images, compose }) {
  await mkdir(outputDirectory, { recursive: true });
  if ((await readdir(outputDirectory)).length) throw new Error("Release output directory must be empty.");
  const rendered = structuredClone(compose);
  delete rendered.name;
  for (const [image, services] of Object.entries(IMAGE_SERVICES)) {
    for (const service of services) {
      if (!rendered.services?.[service]) throw new Error(`Missing Compose service: ${service}.`);
      rendered.services[service].image = images[image];
      delete rendered.services[service].build;
    }
  }
  const environmentMount = rendered.services.backup.volumes.find(volume => volume.target === "/backup-config/.env");
  if (!environmentMount) throw new Error("Missing backup environment mount.");
  Object.assign(environmentMount, { type: "bind", source: "./.env", bind: { create_host_path: false } });
  delete environmentMount.volume;
  await writeFile(path.join(outputDirectory, "docker-compose.rosti.yml"), JSON.stringify(rendered, null, 2) + "\n", { flag: "wx" });
  await mkdir(path.join(outputDirectory, "deploy/scripts"), { recursive: true });
  const sourceScripts = path.join(sourceDirectory, "deploy/scripts");
  for (const name of await readdir(sourceScripts)) {
    if (!assetPath(`deploy/scripts/${name}`) || !(await lstat(path.join(sourceScripts, name))).isFile()) {
      throw new Error(`Unexpected source deployment script: ${name}.`);
    }
    await copyFile(path.join(sourceScripts, name), path.join(outputDirectory, "deploy/scripts", name));
  }
  await copyFile(path.join(sourceDirectory, "deploy/restore.yml"), path.join(outputDirectory, "deploy/restore.yml"));
  const files = {};
  for (const name of await listFiles(outputDirectory)) files[name] = sha256(await readFile(path.join(outputDirectory, name)));
  const manifest = assertReleaseManifest({ schemaVersion: 1, ...release, publicBuild, images, files });
  await writeFile(path.join(outputDirectory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return validateReleaseBundle(outputDirectory);
}
