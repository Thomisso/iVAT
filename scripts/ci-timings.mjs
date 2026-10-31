// Read-only GitHub timing evidence. Usage: node scripts/ci-timings.mjs RUN_ID...
// Queue estimates use the first job start; runner time sums actual job intervals,
// without treating parallel job time or GitHub's billable rounding as wall time.
import { execFileSync } from "node:child_process";
const api = path => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
const repository = JSON.parse(execFileSync("gh", ["repo", "view", "--json", "nameWithOwner"], { encoding: "utf8" })).nameWithOwner;
const reports = [];
for (const id of process.argv.slice(2)) {
  if (!/^\d+$/.test(id)) throw new Error("A numeric GitHub run id is required");
  const run = api(`repos/${repository}/actions/runs/${id}`);
  const jobs = api(`repos/${repository}/actions/runs/${id}/jobs?per_page=100`).jobs;
  if (jobs.length === 100) throw new Error("Job pagination required; refusing incomplete timing evidence");
  const seconds = (start, end) => start && end ? (Date.parse(end) - Date.parse(start)) / 1000 : null;
  const first = jobs.filter(job => job.started_at).map(job => job.started_at).sort()[0];
  const last = jobs.filter(job => job.completed_at).map(job => job.completed_at).sort().at(-1);
  reports.push({
    id, workflow: run.name, revision: run.head_sha, event: run.event,
    conclusion: run.conclusion, createdAt: run.created_at,
    queueSeconds: seconds(run.created_at, first), wallSeconds: seconds(first, last),
    runnerSeconds: jobs.reduce((sum, job) => sum + (seconds(job.started_at, job.completed_at) ?? 0), 0),
    jobs: jobs.map(job => ({ name: job.name, conclusion: job.conclusion, labels: job.labels,
      seconds: seconds(job.started_at, job.completed_at),
      steps: job.steps.map(step => ({ name: step.name, conclusion: step.conclusion, seconds: seconds(step.started_at, step.completed_at) })),
    })),
  });
}
console.log(JSON.stringify(reports, null, 2));
