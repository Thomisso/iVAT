import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const writer = new URL("../write-release-identity.mjs", import.meta.url);

test("a release build records its explicit tag and revision; an unversioned build clears them", t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ivat-build-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (...args) => execFileSync(process.execPath, [writer.pathname, ...args], {
    cwd: directory,
    env: { ...process.env, IVAT_RELEASE_TAG: "v9.9.9", npm_package_version: "0.1.0" },
    stdio: "pipe",
  });
  write("v0.3.0", "a".repeat(40));
  const metadata = path.join(directory, "src/lib/build-identity.json");
  assert.deepEqual(JSON.parse(readFileSync(metadata, "utf8")), { tag: "v0.3.0", revision: "a".repeat(40) });
  for (const args of [["v0.3.0"], ["", "a".repeat(40)], ["v0.3.0-beta.1", "a".repeat(40)], ["v0.3.0", "short"]]) {
    assert.throws(() => write(...args), /Invalid release build identity/);
  }
  write();
  assert.equal(JSON.parse(readFileSync(metadata, "utf8")), null);
});

test("published application images receive the verified release identity, not ambient version values", t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ivat-publish-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("-c", "user.name=Release test", "-c", "user.email=release@example.test", "commit", "--allow-empty", "-m", "Tested revision");
  const revision = git("rev-parse", "HEAD");
  writeFileSync(path.join(directory, "verified.json"), JSON.stringify({ repository: "thomisso/ivat", revision, tag: "v0.3.0", releaseId: 162 }));
  // Docker is the external build boundary. Record its invocation and provide
  // only its documented metadata output; no production image is published.
  const docker = path.join(directory, "docker");
  writeFileSync(docker, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('docker-calls.jsonl', JSON.stringify(args) + '\\n');
fs.writeFileSync(args[args.indexOf('--metadata-file') + 1], JSON.stringify({ 'containerimage.digest': 'sha256:' + 'a'.repeat(64) }));
`);
  chmodSync(docker, 0o755);
  execFileSync(process.execPath, [new URL("../../deploy/scripts/publish-release-images.mjs", import.meta.url).pathname, "verified.json", "images.json"], {
    cwd: directory,
    env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: "Thomisso/iVAT", GITHUB_RUN_ID: "162", GITHUB_RUN_ATTEMPT: "1", ROSTI_PUBLIC_SUPABASE_URL: "https://api.ivat.cz", ROSTI_PUBLIC_SUPABASE_KEY: "sb_publishable_test", IVAT_RELEASE_TAG: "v9.9.9" },
    stdio: "pipe",
  });
  const calls = readFileSync(path.join(directory, "docker-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const app = calls.find(args => args.includes("Dockerfile"));
  assert.ok(app.includes("IVAT_RELEASE_TAG=v0.3.0"));
  assert.ok(app.includes(`IVAT_RELEASE_REVISION=${revision}`));
  assert.ok(app.includes("org.opencontainers.image.version=v0.3.0"));
  assert.ok(app.includes(`org.opencontainers.image.revision=${revision}`));
  assert.ok(app.includes("linux/amd64"));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(directory, "images.json"), "utf8"))).sort(), ["app", "db", "gateway", "proxy"]);
});

test("disposable deployment verification builds an explicit application identity", t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ivat-compose-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, ".env");
  execFileSync(process.execPath, ["deploy/scripts/init.mjs", envFile], { stdio: "pipe" });
  const compose = JSON.parse(execFileSync("docker", ["compose", "--env-file", envFile, "-f", "docker-compose.rosti.yml", "config", "--format", "json"], {
    env: { ...process.env, IVAT_RELEASE_TAG: "v0.0.0", IVAT_RELEASE_REVISION: "c".repeat(40) }, encoding: "utf8", stdio: "pipe",
  }));
  assert.equal(compose.services.web.build.args.IVAT_RELEASE_TAG, "v0.0.0");
  assert.equal(compose.services.web.build.args.IVAT_RELEASE_REVISION, "c".repeat(40));
  assert.equal(compose.services.web.environment.IVAT_RELEASE_TAG, undefined);
  assert.equal(compose.services.worker.environment.IVAT_RELEASE_REVISION, undefined);
});
