import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function repository(t, initial = { "README.md": "Base docs", "src/app/page.tsx": "Base app" }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ivat-ci-main-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  const write = (file, content) => { mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); writeFileSync(path.join(directory, file), content); };
  git("init", "-b", "main");
  git("config", "user.name", "CI main fixture");
  git("config", "user.email", "ci@example.test");
  for (const [file, content] of Object.entries(initial)) write(file, content);
  const commit = message => { git("add", "-A"); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  const before = commit("Base");
  const classify = ({ event = {}, env = {}, raw } = {}) => {
    const after = git("rev-parse", "HEAD");
    write(".git/event.json", raw ?? JSON.stringify({ before, after, ref: "refs/heads/main", forced: false, deleted: false, ...event }));
    write(".git/output", "");
    const result = spawnSync(process.execPath, [new URL("../ci-policy.mjs", import.meta.url).pathname], {
      cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: after,
        GITHUB_EVENT_PATH: path.join(directory, ".git/event.json"), GITHUB_OUTPUT: path.join(directory, ".git/output"), CI_CANDIDATE_FULL: "false", ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = Object.fromEntries(readFileSync(path.join(directory, ".git/output"), "utf8").trim().split("\n").map(line => { const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)]; }));
    return { plan: JSON.parse(output.plan), output, log: result.stdout };
  };
  return { git, write, commit, classify, before };
}

test("verified documentation main pushes publish cheap explicit scopes across the complete multi-commit range", t => {
  const repo = repository(t);
  repo.write("README.md", "First docs"); repo.commit("First docs");
  repo.write("docs/ci.md", "Final docs"); repo.commit("Final docs");
  const { plan, output, log } = repo.classify();
  assert.equal(plan.profile, "docs");
  assert.equal(plan.reason, "documentation-only");
  assert.deepEqual(plan.scopes, { common: false, tracker: false, trackerTransport: false, release: false, application: false, http: false, deployment: false });
  assert.equal(output.deployment, "false");
  assert.match(log, /application: not applicable/);
});

test("a final docs commit cannot hide application, tracker, deployment or shared inputs earlier in a main push", t => {
  for (const [file, tracker, release] of [["src/app/page.tsx", false, false], ["scripts/agent-tracker.mjs", true, false], ["deploy/scripts/init.mjs", false, true], ["package-lock.json", true, true]]) {
    const repo = repository(t);
    repo.write(file, "Relevant change"); repo.commit("Relevant change");
    repo.write("README.md", "Final docs"); repo.commit("Final docs");
    const { plan } = repo.classify();
    assert.equal(plan.profile, "full", file);
    assert.equal(plan.scopes.application, true, file);
    assert.equal(plan.scopes.http, true, file);
    assert.equal(plan.scopes.tracker, tracker, file);
    assert.equal(plan.scopes.release, release, file);
    assert.equal(plan.scopes.deployment, file !== "scripts/agent-tracker.mjs", file);
  }
});

test("main push renames and deletions preserve original runtime and infrastructure dependencies", t => {
  const repo = repository(t, { "README.md": "Docs", "src/app/page.tsx": "Moved runtime", "scripts/agent-tracker.mjs": "Removed tracker", "deploy/scripts/init.mjs": "Removed runtime", "docs/odd\nname.md": "Old" });
  repo.git("mv", "src/app/page.tsx", "docs/moved.md");
  repo.git("rm", "scripts/agent-tracker.mjs", "deploy/scripts/init.mjs");
  repo.write("docs/odd\nname.md", "Changed"); repo.commit("Rename and delete");
  const { plan } = repo.classify();
  assert.equal(plan.scopes.deployment, true);
  assert.equal(plan.scopes.tracker, true);
  assert.equal(plan.scopes.release, true);
  assert.equal(plan.scopes.application, true);
});

test("unavailable, malformed, mismatched and ambiguous main push inputs fail closed through the real CLI", t => {
  const repo = repository(t);
  repo.write("README.md", "Docs update"); const after = repo.commit("Docs");
  const blob = repo.git("hash-object", "-w", "README.md");
  repo.git("checkout", "--orphan", "other");
  repo.write("README.md", "Unrelated history"); const unrelated = repo.commit("Other root");
  repo.git("checkout", "main");
  const cases = [
    { event: { before: undefined } }, { event: { after: undefined } },
    { event: { before: "a".repeat(40) } }, { event: { after: "a".repeat(40) } },
    { event: { before: "0".repeat(40) } }, { event: { before: "HEAD^" } },
    { event: { before: blob } }, { event: { after: blob } },
    { event: { before: unrelated } }, { event: { before: after, after: repo.before }, env: { GITHUB_SHA: repo.before } },
    { event: { forced: true } }, { event: { forced: undefined } },
    { event: { deleted: true } }, { event: { deleted: undefined } }, { event: { created: true } },
    { event: { ref: "refs/heads/other" } }, { env: { GITHUB_REF: "refs/heads/other" } },
    { env: { GITHUB_SHA: repo.before } }, { event: { after: repo.before }, env: { GITHUB_SHA: repo.before } },
    { raw: "null" }, { raw: "{" },
  ];
  for (const input of cases) {
    const { plan } = repo.classify(input);
    assert.equal(plan.reason, "incomplete-diff", JSON.stringify(input));
    assert.ok(Object.values(plan.scopes).every(Boolean), JSON.stringify(input));
  }
  assert.equal(repo.classify({ event: { before: after } }).plan.reason, "empty-diff");
});

test("candidate full verification outranks valid docs pushes and incomplete push metadata", t => {
  const repo = repository(t);
  repo.write("README.md", "Docs update"); repo.commit("Docs");
  for (const event of [{}, { before: undefined }, { forced: true }]) {
    const { plan } = repo.classify({ event, env: { CI_CANDIDATE_FULL: "true" } });
    assert.equal(plan.reason, "full-override");
    assert.ok(Object.values(plan.scopes).every(Boolean));
  }
});

test("single-commit docs remain cheap and a reversed push with a matching checkout cannot use that exemption", t => {
  const repo = repository(t);
  repo.write("README.md", "Docs update"); const tip = repo.commit("Docs");
  assert.equal(repo.classify().plan.profile, "docs");
  repo.git("checkout", "--detach", repo.before);
  const { plan } = repo.classify({ event: { before: tip } });
  assert.equal(plan.reason, "incomplete-diff");
  assert.ok(Object.values(plan.scopes).every(Boolean));
});
