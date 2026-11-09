import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import timings from "./application-test-timings.json";

const durations = new Map(timings.samples.map(sample => [sample.file, sample.milliseconds]));
const measured = [...durations.values()].sort((a, b) => a - b);
// New, renamed and opt-in files stay in Vitest's discovered inventory. Until
// measured, budget the median observed file duration rather than omit them.
const fallbackDuration = measured[Math.floor(measured.length / 2)];

export default class ApplicationTestSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const weighted = files.map(spec => {
      const file = path.relative(this.ctx.config.root, spec.moduleId).split(path.sep).join("/");
      return { spec, file, duration: durations.get(file) ?? fallbackDuration };
    }).sort((a, b) => b.duration - a.duration || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const shards = Array.from({ length: shard.count }, () => ({ duration: 0, files: [] as TestSpecification[] }));
    for (const entry of weighted) {
      // Stable ties choose the lowest shard index on every isolated runner.
      const target = shards.reduce((shortest, candidate) => candidate.duration < shortest.duration ? candidate : shortest);
      target.files.push(entry.spec);
      target.duration += entry.duration;
    }
    return shards[shard.index - 1].files;
  }
}
