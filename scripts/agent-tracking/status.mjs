import { readJournalSnapshot } from "./journal.mjs";
import { projectionSynchronized, statuses } from "./state.mjs";
import { TrackerError } from "./github.mjs";

function ownerSummary(owner) {
  return owner ? { runId: owner.runId, generation: owner.generation, account: owner.account, sequence: owner.sequence } : null;
}

function handoffGate(ticket, counts) {
  if (!ticket.final) return "final_pr_required";
  if (ticket.cancellation) return "implementation_cancelled";
  if (ticket.summary?.checks !== "passed") return "final_checks_required";
  if (ticket.summary?.review !== "passed") return "final_review_required";
  if (ticket.role === "specification") {
    if (!counts || !Object.values(counts).some(count => count > 0) || Object.entries(counts).some(([phase, count]) => count > 0 && !["integrated", "done"].includes(phase))) return "final_children_required";
  } else if (ticket.review?.outcome !== "clean") return "clean_review_required";
  return "remote_validation_required";
}

function issueSummary(ticket, state) {
  let counts = null;
  if (ticket.role === "specification") {
    counts = Object.fromEntries([...Object.keys(statuses), "untracked"].map(phase => [phase, ticket.summary?.counts?.[phase] ?? 0]));
    if (!ticket.summary?.counts) for (const child of Object.values(state.tickets).filter(child => child.parent === ticket.number && (child.parentRepository ?? ticket.repository) === ticket.repository)) counts[child.status ?? "untracked"]++;
  }
  const final = ticket.final;
  return {
    number: ticket.number, role: ticket.role ?? "implementation", parent: ticket.parent ?? null,
    status: ticket.status ?? null, activity: ticket.activity ?? null, agent: ticket.agent ?? null,
    reviewer: ticket.reviewer ?? null, revision: ticket.revision ?? null, stateAt: ticket.stateAt ?? null,
    children: counts ? { counts } : null,
    review: ticket.review ? { revision: ticket.review.revision, outcome: ticket.review.outcome, checksStatus: ticket.review.checksStatus, standards: ticket.review.standards ?? null, spec: ticket.review.spec ?? null } : null,
    final: final ? {
      revision: final.revision, tree: final.tree,
      pullRequest: final.pullRequest ? { number: final.pullRequest.number, url: final.pullRequest.url, state: final.pullRequest.state, revision: final.pullRequest.revision, branch: final.pullRequest.branch, target: final.pullRequest.target } : null,
      checks: { status: ticket.summary?.checks ?? "outstanding", revision: final.checks?.revision ?? null, results: (final.checks?.results ?? []).map(check => ({ name: check.name, status: check.status })) },
      review: { status: ticket.summary?.review ?? "outstanding", revision: final.review?.revision ?? null, reviewer: final.review?.reviewer ?? null, standards: final.review?.standards ?? null, spec: final.review?.spec ?? null },
      handoff: final.handoff ? { state: final.handoff.state, revision: final.handoff.revision } : null,
    } : null,
    handoffGate: { state: handoffGate(ticket, counts), authority: "cached_evidence_only" },
  };
}

function nextStep(issues) {
  const steps = { final_pr_required: "final-pr", final_checks_required: "final-checks", final_review_required: "final-review", final_children_required: "complete_children", clean_review_required: "review", remote_validation_required: "final-handoff", implementation_cancelled: "inspect_cancellation" };
  return issues.length === 1 ? steps[issues[0].handoffGate.state] : "inspect_issues";
}

export function readStatus(config, options = {}) {
  if (options.issue !== undefined && (!/^[1-9][0-9]*$/.test(options.issue) || !Number.isSafeInteger(Number(options.issue)))) throw new TrackerError("issue_invalid");
  const snapshot = readJournalSnapshot(config);
  const journal = snapshot.journal;
  const confirmed = journal?.lastConfirmed;
  const observed = journal?.lastObserved ?? confirmed;
  const observedAt = journal?.lastObserved ? journal.lastObservedAt ?? null : journal?.lastConfirmedAt ?? null;
  const confirmedAt = journal?.lastConfirmedAt ?? null;
  const issues = Object.values(confirmed?.tickets ?? {}).filter(ticket => options.issue === undefined || ticket.number === Number(options.issue)).map(ticket => issueSummary(ticket, confirmed));
  const pending = (journal?.pending ?? []).map(event => ({ id: event.id, type: event.type, issue: event.payload?.issue ?? null, at: event.at, runId: event.runId ?? null, generation: event.generation ?? null, sequence: event.sequence ?? null }));
  return {
    ok: true, source: "local_journal", readAt: new Date().toISOString(), journalWrittenAt: snapshot.writtenAt,
    confirmed: { available: Boolean(confirmed), observedAt: confirmedAt, ageMs: confirmedAt ? Math.max(0, Date.now() - Date.parse(confirmedAt)) : null, revision: confirmed?.revision ?? null, publishedRevision: confirmed?.publishedRevision ?? null, owner: ownerSummary(confirmed?.owner) },
    projection: { available: Boolean(observed), source: journal?.lastObserved ? "last_observed" : confirmed ? "last_confirmed" : "unavailable", observedAt, revision: observed?.revision ?? null, publishedRevision: observed?.publishedRevision ?? null, synchronized: observed ? projectionSynchronized(observed) : null, pendingReceipts: observed ? Object.values(observed.receipts).filter(receipt => receipt.state === "pending").length : null },
    issues, pending: { count: pending.length, events: pending },
    nextStep: pending.length || !confirmed ? "sync" : issues.length ? nextStep(issues) : "discover",
  };
}
