import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { TrackerError } from "./github.mjs";
import { buildFinalPayload, readFinalPullRequest } from "./finalization.mjs";
import { validateEvent } from "./events.mjs";

const steps = ["final-pr", "final-checks", "final-review", "final-handoff"];

function stepOptions(attempt, step, options) {
  return {
    issue: String(attempt.issue), pr: String(attempt.pr), revision: attempt.revision,
    result: attempt.evidence.result, checks: JSON.stringify(attempt.evidence.checks),
    ...attempt.evidence.review, findings: JSON.stringify(attempt.evidence.review.findings),
    "wait-seconds": options["wait-seconds"],
  };
}

function expectedRevision(github, config, attempt, step) {
  const pr = readFinalPullRequest(github, config, attempt.pr);
  if (pr.revision !== attempt.revision) {
    const error = new TrackerError("final_revision_changed");
    error.finalization = { issue: attempt.issue, pr: attempt.pr, step, expectedRevision: attempt.revision, actualRevision: pr.revision };
    throw error;
  }
}

function createAttempt(options, journal) {
  const issue = Number(options.issue), pr = Number(options.pr), revision = options.revision;
  if (![issue, pr].every(number => Number.isSafeInteger(number) && number > 0) || !/^[a-f0-9]{40}$/.test(revision ?? "")) throw new TrackerError("finalization_input_invalid");
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(options["evidence-file"], "utf8")); }
  catch { throw new TrackerError("finalization_evidence_invalid"); }
  if (!evidence || evidence.revision !== revision || !evidence.review || typeof evidence.review !== "object" || Array.isArray(evidence.review)
    || Object.keys(evidence).some(key => !["revision", "result", "checks", "review"].includes(key))
    || Object.keys(evidence.review).some(key => !["reviewer", "standards", "spec", "findings", "independence", "evidence"].includes(key))) throw new TrackerError("finalization_evidence_invalid");
  const attempt = { id: randomUUID(), issue, pr, revision, evidence, run: { ...journal.run }, at: new Date().toISOString(), state: "running", steps: {} };
  for (const step of steps) validateEvent({ id: attempt.id, type: step, ...journal.run, sequence: journal.nextSequence, at: attempt.at, payload: buildFinalPayload(step, stepOptions(attempt, step, options)) });
  return attempt;
}

export function finalize(github, config, journal, save, options, execute) {
  if (!journal.run) throw new TrackerError("owned_run_required");
  if (journal.stopRequested) throw new TrackerError("run_stop_pending");
  const issue = Number(options.issue);
  let attempt = journal.finalizations?.findLast(item => item.issue === issue);
  if (options["new-attempt"] || !attempt) {
    if (journal.pending.length) throw new TrackerError("pending_events_require_sync");
    const created = createAttempt(options, journal);
    expectedRevision(github, config, created, "final-pr");
    journal.finalizations ??= [];
    journal.finalizations.push(created);
    attempt = created;
    save();
  } else {
    if (!isDeepStrictEqual(attempt.run, journal.run)) throw new TrackerError("finalization_owner_changed");
    if ((options.pr && Number(options.pr) !== attempt.pr) || (options.revision && options.revision !== attempt.revision)) throw new TrackerError("finalization_inputs_changed");
    if (options["evidence-file"]) {
      let evidence;
      try { evidence = JSON.parse(fs.readFileSync(options["evidence-file"], "utf8")); } catch { throw new TrackerError("finalization_evidence_invalid"); }
      if (!isDeepStrictEqual(evidence, attempt.evidence)) throw new TrackerError("finalization_inputs_changed");
    }
  }
  const requireNotRejected = () => {
    if (attempt.state !== "rejected") return;
    const [step, checkpoint] = Object.entries(attempt.steps).find(([, checkpoint]) => checkpoint.state === "rejected");
    const error = new TrackerError(checkpoint.error);
    error.finalization = { issue, pr: attempt.pr, step, state: "rejected", nextStep: "new-attempt" };
    throw error;
  };
  requireNotRejected();
  execute("sync", options);
  requireNotRejected();
  for (const step of steps) {
    if (attempt.steps[step]?.state === "published") continue;
    expectedRevision(github, config, attempt, step);
    execute(step, stepOptions(attempt, step, options), event => {
      attempt.steps[step] = { id: event.id, at: event.at, state: "pending" };
    });
  }
  expectedRevision(github, config, attempt, "complete");
  attempt.state = "complete";
  save();
  return { ok: true, finalization: { id: attempt.id, issue, pr: attempt.pr, revision: attempt.revision, state: attempt.state } };
}

// Called inside the same atomic journal save which consumes the real receipt.
export function checkpointFinalization(journal, event, receipt) {
  for (const attempt of journal.finalizations ?? []) {
    const step = attempt.steps[event.type];
    if (step?.id !== event.id) continue;
    step.state = receipt.state;
    step.revision = receipt.revision;
    if (receipt.state === "rejected") { step.error = receipt.error; attempt.state = "rejected"; }
    else if (event.type === "final-handoff") attempt.state = "complete";
  }
}
