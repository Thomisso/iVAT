import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { assertPublishedRelease, requiredChecksState, resolveReleaseRevision } from "../scripts/release-policy.mjs";
import { assertPublicBuild, assertReleaseManifest, createReleaseBundle, validateReleaseBundle } from "../scripts/release-bundle.mjs";
import { waitForRequiredChecks } from "../scripts/prepare-release.mjs";

test("only a published stable versioned Release can select production contents", () => {
  const release = { id: 42, tag_name: "v0.2.0", draft: false, prerelease: false };
  assert.deepEqual(assertPublishedRelease("release", { action: "published", release }), {
    releaseId: 42,
    tag: "v0.2.0",
  });
  for (const event of [
    { action: "created", release },
    { action: "published", release: { ...release, draft: true } },
    { action: "published", release: { ...release, prerelease: true } },
    { action: "published", release: { ...release, tag_name: "v0.2.0-beta.1" } },
    { action: "published", release: { ...release, tag_name: "main; touch bad" } },
  ]) assert.throws(() => assertPublishedRelease("release", event), /published stable/);
  assert.throws(() => assertPublishedRelease("push", { action: "published", release }), /published stable/);
});

test("workflow evidence polling waits for exact checks and stops at a bounded deadline or API error", async t => {
  const revision = "a".repeat(40);
  let conclusion = null;
  let status = 200;
  let body = null;
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(body ?? JSON.stringify({ workflow_runs: [{ id: 10, head_sha: revision, head_branch: "main", event: "push", status: conclusion ? "completed" : "in_progress", conclusion }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { repository: "thomisso/ivat", revision, token: "test-token", apiUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 100, pollMs: 5 };
  await assert.rejects(waitForRequiredChecks(options), /Timed out/);
  conclusion = "success";
  await waitForRequiredChecks(options);
  assert.ok(requests.some(url => url === `/repos/thomisso/ivat/actions/workflows/ci.yml/runs?head_sha=${revision}&branch=main&event=push&per_page=100`));
  assert.ok(requests.some(url => url.startsWith("/repos/thomisso/ivat/actions/workflows/deployment-check.yml/runs?")));
  status = 403;
  await assert.rejects(waitForRequiredChecks(options), /GitHub.*403/);
  status = 200;
  body = "<html>upstream internal response</html>";
  await assert.rejects(waitForRequiredChecks(options), /Invalid GitHub workflow evidence/);
});

test("a verified release produces a strict bundle that pins images and refuses tampering", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "ivat-release-bundle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const images = {
    app: `ghcr.io/thomisso/ivat/app@sha256:${"a".repeat(64)}`,
    db: `ghcr.io/thomisso/ivat/db@sha256:${"b".repeat(64)}`,
    gateway: `ghcr.io/thomisso/ivat/gateway@sha256:${"c".repeat(64)}`,
    proxy: `ghcr.io/thomisso/ivat/proxy@sha256:${"d".repeat(64)}`,
  };
  const compose = JSON.parse(execFileSync("docker", ["compose", "-f", "docker-compose.rosti.yml", "config", "--no-interpolate", "--no-path-resolution", "--format", "json"], { encoding: "utf8" }));
  await createReleaseBundle({
    sourceDirectory: process.cwd(), outputDirectory: directory,
    release: {
      repository: "thomisso/ivat", revision: "a".repeat(40), tag: "v0.2.0", releaseId: 42,
      // The real verification CLI retains this receipt beside the identity.
      verification: { candidate: { inputsDigest: "e".repeat(64) }, receipt: { runId: 20, runAttempt: 1, artifactId: 30, artifactDigest: `sha256:${"f".repeat(64)}` } },
    },
    publicBuild: { supabaseUrl: "https://api.ivat.cz", publishableKey: "sb_publishable_release_test" },
    images, compose,
  });
  const manifest = await validateReleaseBundle(directory);
  assert.equal(manifest.revision, "a".repeat(40));
  assert.equal(manifest.verification, undefined, "verification metadata is not a deployment manifest field");
  assert.throws(() => assertReleaseManifest({ ...manifest, verification: {} }), /Invalid release manifest identity/);
  assert.equal(Object.keys(manifest.images).length, 4);
  const rendered = JSON.parse(readFileSync(path.join(directory, "docker-compose.rosti.yml"), "utf8"));
  assert.equal(rendered.name, undefined);
  for (const service of ["web", "worker", "migrate", "backup"]) assert.equal(rendered.services[service].image, images.app);
  assert.equal(rendered.services.db.image, images.db);
  assert.equal(rendered.services.gateway.image, images.gateway);
  assert.equal(rendered.services.proxy.image, images.proxy);
  assert.equal(rendered.services.web.build, undefined);
  assert.equal(rendered.services.web.environment.SUPABASE_SECRET_KEY, "${SERVICE_ROLE_KEY:?Missing SERVICE_ROLE_KEY}");
  assert.equal(rendered.services.backup.volumes[0].source, "./.env");
  const originalManifest = readFileSync(path.join(directory, "manifest.json"), "utf8");
  const { createHash } = await import("node:crypto");
  rendered.services.worker.image = images.db;
  const changedCompose = JSON.stringify(rendered);
  const changedManifest = JSON.parse(originalManifest);
  changedManifest.files["docker-compose.rosti.yml"] = createHash("sha256").update(changedCompose).digest("hex");
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(changedManifest));
  const originalCompose = readFileSync(path.join(directory, "docker-compose.rosti.yml"));
  writeFileSync(path.join(directory, "docker-compose.rosti.yml"), changedCompose);
  await assert.rejects(validateReleaseBundle(directory), /image does not match manifest: worker/);
  writeFileSync(path.join(directory, "docker-compose.rosti.yml"), originalCompose);
  changedManifest.files["../escape.sh"] = "e".repeat(64);
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(changedManifest));
  await assert.rejects(validateReleaseBundle(directory), /Invalid release asset/);
  writeFileSync(path.join(directory, "manifest.json"), originalManifest);
  const malformedImage = JSON.parse(originalManifest);
  malformedImage.images.app += `@sha256:${"e".repeat(64)}`;
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(malformedImage));
  await assert.rejects(validateReleaseBundle(directory), /Invalid immutable image reference/);
  writeFileSync(path.join(directory, "manifest.json"), originalManifest);
  writeFileSync(path.join(directory, "unexpected.sh"), "exit 0\n");
  await assert.rejects(validateReleaseBundle(directory), /Unexpected release asset/);
  rmSync(path.join(directory, "unexpected.sh"));
  symlinkSync("/etc/passwd", path.join(directory, "deploy/scripts/unexpected.mjs"));
  await assert.rejects(validateReleaseBundle(directory), /Symbolic links/);
  rmSync(path.join(directory, "deploy/scripts/unexpected.mjs"));
  writeFileSync(path.join(directory, "deploy/scripts/migrate.mjs"), "tampered\n");
  await assert.rejects(validateReleaseBundle(directory), /checksum/);
});

test("only public Supabase settings can reach Docker build arguments", () => {
  assert.doesNotThrow(() => assertPublicBuild({ supabaseUrl: "https://api.ivat.cz", publishableKey: "sb_publishable_release_test" }));
  for (const publishableKey of ["sb_secret_private", `header.${Buffer.from('{"role":"service_role"}').toString("base64url")}.signature`]) {
    assert.throws(() => assertPublicBuild({ supabaseUrl: "https://api.ivat.cz", publishableKey }), /public publishable\/anon/);
  }
  for (const supabaseUrl of ["http://api.ivat.cz", "https://user:password@api.ivat.cz", "https://api.ivat.cz/private"]) {
    assert.throws(() => assertPublicBuild({ supabaseUrl, publishableKey: "sb_publishable_release_test" }), /HTTPS origin/);
  }
});

test("only successful latest main-push runs for the exact commit satisfy release checks", () => {
  const revision = "a".repeat(40);
  const green = { id: 10, head_sha: revision, head_branch: "main", event: "push", status: "completed", conclusion: "success" };
  const checks = { "ci.yml": [green], "deployment-check.yml": [green] };
  assert.equal(requiredChecksState(checks, revision), "success");
  assert.equal(requiredChecksState({ ...checks, "ci.yml": [] }, revision), "waiting");
  for (const invalid of [{ ...green, head_sha: "b".repeat(40) }, { ...green, event: "pull_request" }, { ...green, head_branch: "feature" }]) {
    assert.equal(requiredChecksState({ ...checks, "ci.yml": [invalid] }, revision), "waiting");
  }
  assert.equal(requiredChecksState({ ...checks, "ci.yml": [green, { ...green, id: 11, status: "in_progress", conclusion: null }] }, revision), "waiting");
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral", "timed_out"]) {
    assert.throws(() => requiredChecksState({ ...checks, "ci.yml": [green, { ...green, id: 11, conclusion }] }, revision), /ci.yml.*did not succeed/);
  }
});

test("release resolution peels annotated tags and refuses changed tags or commits outside main", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "ivat-release-git-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "release-test@example.test");
  git("config", "user.name", "Release test");
  writeFileSync(path.join(directory, "source.txt"), "first revision\n");
  git("add", ".");
  git("commit", "-m", "first");
  const main = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", main);
  git("tag", "-a", "v0.2.0", "-m", "release");
  assert.equal(resolveReleaseRevision("v0.2.0", main, directory), main);
  assert.throws(() => resolveReleaseRevision("v0.2.0", "b".repeat(40), directory), /changed/);
  git("checkout", "-b", "feature");
  writeFileSync(path.join(directory, "source.txt"), "feature revision\n");
  git("commit", "-am", "feature");
  const feature = git("rev-parse", "HEAD");
  git("tag", "v0.3.0");
  assert.throws(() => resolveReleaseRevision("v0.3.0", feature, directory), /not on main/);
});
