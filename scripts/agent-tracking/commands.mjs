import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { TrackerError } from "./github.mjs";
import { readRegistry } from "./state.mjs";
import { validateEvent } from "./events.mjs";
import { withJournal } from "./journal.mjs";
import { validateConfig } from "./config.mjs";
import { synchronize as sync, quarantineRun } from "./outbox.mjs";
import { collectLocalFacts } from "./recovery.mjs";

export function runCommand(command, github, config, options) {
  return withJournal(config, (journal, save) => {
    if (command === "show") return options.local ? { ok: true, local: journal } : { ok: true, local: journal, remote: readRegistry(github, config).state };
    if (command === "sync") return sync(github, config, journal, save, options);
    const at = options.at ?? new Date().toISOString();
    let event;
    if (command === "start") {
      if (journal.pending.length) throw new TrackerError("pending_events_require_sync");
      if (journal.run) throw new TrackerError("run_already_owned");
      validateConfig(github, config);
      const remote = readRegistry(github, config).state;
      if (remote.owner) throw new TrackerError("run_already_owned");
      event = { id: randomUUID(), type: "start", runId: options.run ?? randomUUID(), generation: remote.generation, sequence: 0, at, payload: {} };
      journal.nextSequence = 1;
    } else if (command === "stop") {
      if (!journal.run) throw new TrackerError("owned_run_required");
      event = { id: randomUUID(), type: "stop", ...journal.run, sequence: journal.nextSequence, at, payload: { reason: options.reason } };
    } else if (command === "resume") {
      if (journal.pending.length && !options.recover) sync(github, config, journal, save, options);
      validateConfig(github, config);
      const remote = readRegistry(github, config).state;
      if (remote.owner) {
        if (options.recover) {
          if (options.run !== remote.owner.runId) throw new TrackerError("expected_run_required");
          if (github.request("user").login !== remote.owner.account) throw new TrackerError("run_actor_mismatch");
          event = { id: randomUUID(), type: "takeover", runId: remote.owner.runId, generation: remote.generation, sequence: 0, at, payload: { fromRunId: remote.owner.runId, fromGeneration: remote.generation, reason: options.reason, source: "remote-recovery", localFacts: collectLocalFacts(remote, remote.owner.runId) } };
        } else {
          if (!journal.run || remote.owner.runId !== journal.run.runId || remote.owner.generation !== journal.run.generation || journal.lastConfirmed?.owner?.runId !== journal.run.runId || journal.lastConfirmed.owner.generation !== journal.run.generation) throw new TrackerError("owned_run_required");
          event = { id: randomUUID(), type: "resume", ...journal.run, sequence: journal.nextSequence, at, payload: { source: "local", localFacts: collectLocalFacts(remote, remote.owner.runId) } };
        }
      } else {
        const prior = remote.runHistory?.[remote.generation];
        if (!prior || prior.kind !== "stopped" || (options.run ?? journal.stoppedRun?.runId) !== prior.runId) throw new TrackerError("stopped_run_required");
        if (!options.recover && journal.stoppedRun?.runId !== prior.runId) throw new TrackerError("owned_run_required");
        if (github.request("user").login !== prior.account) throw new TrackerError("run_actor_mismatch");
        event = { id: randomUUID(), type: "restart", runId: prior.runId, generation: remote.generation, sequence: 0, at, payload: { reason: options.recover ? options.reason : options.reason ?? "Explicitly resumed stopped run", source: options.recover ? "remote-recovery" : "local-restart", localFacts: collectLocalFacts(remote, prior.runId) } };
        journal.nextSequence = 1;
      }
    } else if (command === "takeover") {
      validateConfig(github, config);
      const remote = readRegistry(github, config).state;
      if (!remote.owner || options["from-run"] !== remote.owner.runId || Number(options["from-generation"]) !== remote.owner.generation) throw new TrackerError("run_superseded");
      if (github.request("user").login !== remote.owner.account) throw new TrackerError("run_actor_mismatch");
      event = { id: randomUUID(), type: "takeover", runId: options.run ?? randomUUID(), generation: remote.generation, sequence: 0, at, payload: { fromRunId: remote.owner.runId, fromGeneration: remote.owner.generation, reason: options.reason, source: "takeover", localFacts: collectLocalFacts(remote, remote.owner.runId) } };
    } else if (command === "repair") {
      event = { id: randomUUID(), type: "repair", at, payload: {} };
    } else if (command === "claim") {
      if (!journal.run) throw new TrackerError("owned_run_required");
      if (journal.stopRequested) throw new TrackerError("run_stop_pending");
      let branchRevision;
      try { branchRevision = execFileSync("git", ["rev-parse", "--verify", `refs/heads/${options.branch}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
      catch { throw new TrackerError("branch_missing"); }
      event = { id: randomUUID(), type: "claim", ...journal.run, sequence: journal.nextSequence, at, payload: { issue: Number(options.issue), agent: options.agent, branch: options.branch, branchRevision, result: options.result ?? "Implementation started" } };
    } else throw new TrackerError("command_unknown");
    validateEvent(event);
    if (["restart", "takeover"].includes(event.type)) {
      if (journal.pending.length) quarantineRun(journal, save, "explicit_recovery");
      journal.nextSequence = 1;
    }
    journal.pending.push(event);
    if (event.type === "stop") journal.stopRequested = event.id;
    if (!["start", "restart", "takeover", "repair"].includes(event.type)) journal.nextSequence++;
    save();
    return sync(github, config, journal, save, options);
  });
}
