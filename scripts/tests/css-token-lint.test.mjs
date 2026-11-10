import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const command = new URL("../lint-css-tokens.mjs", import.meta.url).pathname;

function repository(t, initial = ".legacy { margin: 0 0 16px; background: #fff; }\n") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ivat-css-token-lint-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  const write = (file, content) => { mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); writeFileSync(path.join(directory, file), content); };
  git("init", "-b", "main");
  git("config", "user.name", "CSS lint fixture");
  git("config", "user.email", "css@example.test");
  write("src/app/globals.css", initial);
  git("add", "-A"); git("commit", "-m", "Existing CSS");
  const base = git("rev-parse", "HEAD");
  const lint = (args = ["--base", base], environment = {}) => spawnSync(process.execPath, [command, ...args], { cwd: directory, encoding: "utf8", env: { PATH: process.env.PATH, ...environment } });
  return { write, git, lint, base, directory };
}

test("new spacing declarations report the file, position and existing token", t => {
  const repo = repository(t);
  repo.write("src/app/globals.css", ".new { margin: 0 0 16px; }\n");
  const result = repo.lint();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/app\/globals\.css:1:8.*margin.*16px.*var\(--space-4\)/);
});

test("untouched historical declarations survive nearby changes but changed and duplicate declarations are checked", t => {
  const repo = repository(t);
  repo.write("src/app/globals.css", ".legacy { margin: 0 0 16px; background: #fff; display: block; }\n");
  assert.equal(repo.lint().status, 0, "untouched declarations stay outside the gate");
  repo.write("src/app/globals.css", ".legacy { margin: 0 0 16px; background: #fff; margin: 16px; }\n");
  const duplicate = repo.lint();
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.stderr.trim().split("\n").length, 1);
  repo.write("src/app/globals.css", ".legacy { margin: 0 0 20px; background: #fff; }\n");
  assert.match(repo.lint().stderr, /20px.*var\(--space-5\)/);
});

test("new untracked CSS catches token colors in declarations and nested functions without treating URLs or strings as colors", t => {
  const repo = repository(t);
  repo.write("src/components/card.module.css", '.card { background: #fff; color: rgb(28 28 26); border: 1px solid #E2E2DC; box-shadow: 0 0 1px rgba(31, 95, 139, 1); background-image: url("#fff"); content: "#fff"; }\n');
  const result = repo.lint();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /card\.module\.css:1:9.*background.*#fff.*var\(--surface\)/);
  assert.match(result.stderr, /color.*rgb\(28 28 26\).*var\(--ink\)/);
  assert.match(result.stderr, /border.*#E2E2DC.*var\(--line\)/);
  assert.match(result.stderr, /box-shadow.*rgba\(31, 95, 139, 1\).*var\(--accent\)/);
  assert.equal(result.stderr.trim().split("\n").length, 4);
});

test("spacing tokens apply to padding, logical margins and gaps including negative and rem equivalents", t => {
  const repo = repository(t);
  repo.write("src/components/spacing.css", ".panel { padding: 8px; margin-block-end: -16px; gap: 1rem; row-gap: clamp(0px, 2vw, 24px); }\n");
  const result = repo.lint();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /padding.*var\(--space-2\)/);
  assert.match(result.stderr, /margin-block-end.*calc\(-1 \* var\(--space-4\)\)/);
  assert.match(result.stderr, /gap: 1rem.*var\(--space-4\)/);
  assert.match(result.stderr, /row-gap: 24px.*var\(--space-6\)/);
});

test("token definitions, token usage and legitimate untokened values pass with a declaration-local documented exception", t => {
  const repo = repository(t);
  repo.write("src/components/allowed.css", `:root { --surface: #fff; --space-4: 16px; }
.ok {
  margin: 0 0 var(--space-4);
  padding: 3px 5%; gap: 7px; width: 16px; font-size: 16px;
  background: var(--surface); color: currentColor;
  border: 1px solid transparent; outline-offset: 3px;
  /* token-lint-exception: exported document paper must stay literal white */
  background-color: #fff;
}
`);
  const result = repo.lint();
  assert.equal(result.status, 0, result.stderr);
  repo.write("src/components/allowed.css", ".bad { /* token-lint-exception: */ background: #fff; }\n");
  const invalid = repo.lint();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /exception.*reason/);
});

test("PR and main-push CI use the complete event base while local work uses origin/main", t => {
  const repo = repository(t);
  repo.git("update-ref", "refs/remotes/origin/main", repo.base);
  repo.write("src/app/globals.css", ".legacy { margin: 0 0 16px; background: #fff; }\n.new { padding: 16px; }\n");
  repo.git("add", "-A"); repo.git("commit", "-m", "New CSS declaration");
  const assertViolation = result => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /padding: 16px.*var\(--space-4\)/);
  };
  assertViolation(repo.lint([]));
  for (const draft of [true, false]) {
    repo.write("event.json", JSON.stringify({ pull_request: { base: { sha: repo.base }, draft } }));
    assertViolation(repo.lint([], { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: path.join(repo.directory, "event.json") }));
  }
  repo.write("event.json", JSON.stringify({ before: repo.base }));
  assertViolation(repo.lint([], { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: path.join(repo.directory, "event.json") }));
});

test("historical declaration allowances stay scoped to selector, media context and occurrence count", t => {
  const repo = repository(t, ".legacy { margin: 16px; }\n@media (min-width: 800px) { .legacy { padding: 8px; } }\n");
  repo.write("src/app/globals.css", ".legacy { margin: 16px; margin: 16px; }\n@media (min-width: 900px) { .legacy { padding: 8px; } }\n");
  const result = repo.lint();
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim().split("\n").length, 2);
  assert.match(result.stderr, /margin: 16px/);
  assert.match(result.stderr, /padding: 8px/);
});

test("missing CI metadata, unavailable bases and invalid CSS refuse a successful lint", t => {
  const repo = repository(t);
  assert.equal(repo.lint(["--base", "missing-revision"]).status, 1);
  repo.write("event.json", JSON.stringify({ pull_request: { base: {} } }));
  const metadata = repo.lint([], { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: path.join(repo.directory, "event.json") });
  assert.equal(metadata.status, 1);
  assert.match(metadata.stderr, /Missing CI base revision/);
  repo.write("src/app/globals.css", ".broken { background: #fff;\n");
  const syntax = repo.lint();
  assert.equal(syntax.status, 1);
  assert.match(syntax.stderr, /Unclosed block/);
});
