import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createVitest } from "vitest/node";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("the serial runner balances measured files across the three isolated CI shards", async () => {
  const fixture = await mkdtemp(path.join(root, ".shard-tests-"));
  try {
    await mkdir(path.join(fixture, "tests"));
    const names = ["review", "internal-supabase-transport", "mfa-replacement", "source-recovery", "automatic-approval", "invitations-lifecycle"];
    for (const name of names) {
      await writeFile(path.join(fixture, `tests/${name}.test.ts`), 'import { it } from "vitest"; it("runs", () => {});');
    }
    const config = path.join(fixture, "vitest.config.mts");
    await writeFile(config, `import base from ${JSON.stringify(path.join(root, "vitest.config.ts"))}; export default { ...base, test: { ...base.test, globalSetup: [] } };`);
    const selected = [];
    for (let index = 1; index <= 3; index++) {
      const files = [];
      const runner = await createVitest({ config, root: fixture, shard: `${index}/3`, maxWorkers: 1, watch: false, reporters: [{ onTestModuleEnd(module) { files.push(path.basename(module.moduleId)); } }] });
      try {
        assert.equal(runner.config.fileParallelism, false);
        assert.equal(runner.config.maxWorkers, 1);
        const result = await runner.start();
        assert.deepEqual(result.unhandledErrors, []);
        assert.ok(result.testModules.every(module => module.state() === "passed"));
        selected.push(files.sort());
      } finally {
        await runner.close();
      }
    }
    // Worked example from the recorded run: 58.107s / 55.850s / 57.943s.
    assert.deepEqual(selected, [
      ["invitations-lifecycle.test.ts", "review.test.ts"],
      ["automatic-approval.test.ts", "internal-supabase-transport.test.ts"],
      ["mfa-replacement.test.ts", "source-recovery.test.ts"],
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

// Selection uses the configured Vitest extension boundary, not a second glob or
// a timing-file allowlist. No application modules or database setup execute.
test("every discovered application file is selected exactly once, including unmeasured opt-in files", async t => {
  const runner = await createVitest({ config: path.join(root, "vitest.config.ts"), root, watch: false, reporters: [] });
  try {
    const inventory = await runner.globTestSpecifications();
    const all = inventory.map(spec => path.relative(root, spec.moduleId)).sort();
    const selected = [];
    const durations = JSON.parse(await readFile(path.join(root, "scripts/application-test-timings.json"), "utf8"));
    const measurements = new Map(durations.samples.map(sample => [sample.file, sample.milliseconds]));
    const estimates = [];
    for (let index = 1; index <= 3; index++) {
      runner.config.shard = { index, count: 3 };
      const sequencer = new runner.config.sequence.sequencer(runner);
      const files = (await sequencer.shard(inventory)).map(spec => path.relative(root, spec.moduleId)).sort();
      const reversed = (await sequencer.shard([...inventory].reverse())).map(spec => path.relative(root, spec.moduleId)).sort();
      assert.deepEqual(reversed, files, "discovery order cannot change isolated runners' assignment");
      selected.push(...files);
      estimates.push(files.reduce((sum, file) => sum + (measurements.get(file) ?? 5500), 0));
    }
    assert.deepEqual(selected.sort(), all);
    assert.equal(new Set(selected).size, all.length);
    for (const file of ["tests/contract/adis-vat-registry.test.ts", "tests/contract/anthropic.test.ts", "tests/contract/ares.test.ts", "tests/contract/cnb-rates.test.ts", "tests/contract/openai.test.ts", "tests/simulation/openai.test.ts"]) {
      assert.ok(selected.includes(file), `${file} remains selected with its existing opt-in behavior`);
    }
    // Added files increase unavoidable work; a fixed wall-time estimate cannot
    // test balance. Budget at most one recorded-median fallback (5.500s) above
    // the inventory's mathematical lower bound, retaining a strict imbalance
    // check without inventing measurements for new/opt-in files.
    const weights = all.map(file => measurements.get(file) ?? 5500);
    const lowerBound = Math.max(Math.ceil(weights.reduce((sum, duration) => sum + duration, 0) / 3), ...weights);
    assert.ok(Math.max(...estimates) <= lowerBound + 5500, `predicted loads: ${estimates}; lower bound: ${lowerBound}`);
    t.diagnostic(`${all.length} files selected once; predicted file-duration totals ${estimates.join("/")}ms, including 5500ms fallback per unmeasured file`);
  } finally {
    await runner.close();
  }
});

test("new and renamed test files receive stable median-duration assignments", async () => {
  const fixture = await mkdtemp(path.join(root, ".shard-tests-"));
  let runner;
  try {
    await mkdir(path.join(fixture, "tests"));
    for (const name of ["review", "mfa-replacement", "source-recovery", "brand-new", "renamed-review"]) {
      await writeFile(path.join(fixture, `tests/${name}.test.ts`), 'import { it } from "vitest"; it("runs", () => {});');
    }
    const config = path.join(fixture, "vitest.config.mts");
    await writeFile(config, `import base from ${JSON.stringify(path.join(root, "vitest.config.ts"))}; export default { ...base, test: { ...base.test, globalSetup: [] } };`);
    runner = await createVitest({ config, root: fixture, watch: false, reporters: [] });
    const inventory = await runner.globTestSpecifications();
    const selected = [];
    for (let index = 1; index <= 3; index++) {
      runner.config.shard = { index, count: 3 };
      const sequencer = new runner.config.sequence.sequencer(runner);
      selected.push((await sequencer.shard(inventory)).map(spec => path.basename(spec.moduleId)).sort());
    }
    // The two unknown paths each receive the recorded median, 5.500s.
    // Resulting loads: 38.728s / 35.228s / 33.715s.
    assert.deepEqual(selected, [
      ["review.test.ts"],
      ["mfa-replacement.test.ts", "renamed-review.test.ts"],
      ["brand-new.test.ts", "source-recovery.test.ts"],
    ]);
  } finally {
    await runner?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
