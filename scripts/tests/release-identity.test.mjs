import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer } from "node:http";
import { promisify } from "node:util";
import { createCandidate } from "../../deploy/scripts/release-evidence.mjs";

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

test("published application images receive the verified release identity, not ambient version values", async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ivat-publish-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  for (const file of [".github/workflows/ci.yml", ".github/workflows/deployment-check.yml", ".github/workflows/release-verification.yml", "scripts/ci-policy.mjs", "deploy/scripts/release-evidence.mjs"]) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); writeFileSync(path.join(directory, file), "reviewed policy\n");
  }
  git("add", ".");
  git("-c", "user.name=Release test", "-c", "user.email=release@example.test", "commit", "-m", "Tested revision");
  const revision = git("rev-parse", "HEAD");
  git("-c", "user.name=Release test", "-c", "user.email=release@example.test", "tag", "-a", "v0.3.0", "-m", "Annotated release");
  git("update-ref", "refs/remotes/origin/main", revision);
  const publicBuild = { supabaseUrl: "https://api.ivat.cz", publishableKey: "sb_publishable_test" };
  const candidate = createCandidate({ repository: "thomisso/ivat", revision, tag: "v0.3.0", publicBuild, directory });
  writeFileSync(path.join(directory, "verified.json"), JSON.stringify({ repository: "thomisso/ivat", revision, tag: "v0.3.0", releaseId: 162, verification: { candidate,
    receipt: { runId: 20, runAttempt: 1, artifactId: 30, artifactDigest: `sha256:${"e".repeat(64)}` } } }));
  let latestAttempt = 1;
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const pathname = decodeURIComponent(new URL(request.url, "http://local.test").pathname);
    let body;
    if (pathname.endsWith("/commits/tags/v0.3.0")) { response.writeHead(422); return response.end(JSON.stringify({ message: "No commit found for SHA: tags/v0.3.0" })); }
    if (pathname.endsWith("/commits/heads/main") || pathname.endsWith("/commits/refs/tags/v0.3.0")) body = { sha: revision, commit: { tree: { sha: candidate.sourceTree } } };
    else if (request.url.includes("/actions/runs/20/artifacts")) body = { total_count: 1, artifacts: [{ id: 30, name: "release-verification-20-1", expired: false, expires_at: "2099-01-01T00:00:00Z", digest: `sha256:${"e".repeat(64)}`, workflow_run: { id: 20, repository_id: 99, head_repository_id: 99, head_sha: revision } }] };
    else if (request.url.includes("/actions/runs/20")) body = { id: 20, run_attempt: latestAttempt, event: "workflow_dispatch", head_sha: revision, path: ".github/workflows/release-verification.yml", repository: { id: 99, full_name: "Thomisso/iVAT" }, head_repository: { id: 99, full_name: "Thomisso/iVAT" }, display_title: `Release verification ${candidate.requestId}`, status: "completed", conclusion: "success", created_at: candidate.requestedAt, run_started_at: candidate.requestedAt, referenced_workflows: ["ci.yml", "deployment-check.yml"].map(file => ({ path: `thomisso/ivat/.github/workflows/${file}@${candidate.sourceRef}`, sha: revision })) };
    else { response.writeHead(501); return response.end(); }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
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
  await promisify(execFile)(process.execPath, [new URL("../../deploy/scripts/publish-release-images.mjs", import.meta.url).pathname, "verified.json", "images.json"], {
    cwd: directory,
    env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: "Thomisso/iVAT", GH_TOKEN: "disposable-test-token", GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_RUN_ID: "162", GITHUB_RUN_ATTEMPT: "1", ROSTI_PUBLIC_SUPABASE_URL: "https://api.ivat.cz", ROSTI_PUBLIC_SUPABASE_KEY: "sb_publishable_test", IVAT_RELEASE_TAG: "v9.9.9" },
    stdio: "pipe",
  });
  latestAttempt = 2;
  await assert.rejects(promisify(execFile)(process.execPath, [new URL("../../deploy/scripts/publish-release-images.mjs", import.meta.url).pathname, "verified.json", "other-images.json"], {
    cwd: directory, env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, GH_TOKEN: "disposable-test-token", GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      GITHUB_REPOSITORY: "Thomisso/iVAT", GITHUB_RUN_ID: "162", GITHUB_RUN_ATTEMPT: "1", ROSTI_PUBLIC_SUPABASE_URL: publicBuild.supabaseUrl, ROSTI_PUBLIC_SUPABASE_KEY: publicBuild.publishableKey },
  }), /attempt changed/);
  assert.ok(requests.some(route => route.endsWith("/commits/refs%2Ftags%2Fv0.3.0")));
  assert.ok(requests.every(route => !route.includes("/commits/tags%2F")));
  const calls = readFileSync(path.join(directory, "docker-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 4, "a stale receipt cannot start another image publication");
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
