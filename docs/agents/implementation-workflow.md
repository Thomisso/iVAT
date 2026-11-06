# Multi-ticket implementation

Use this workflow when one spec is implemented through parallel tickets. Its completion criterion is one reviewable integration pull request whose child diffs and combined behavior have both passed review.

## Reporting entry point

For standalone `implement`, use the shared tracker to claim, hand off completed implementation/focused checks, record an independent review and return findings to implementation. Omit integration context when the flow has none. For `implement-spec`, the controller binds each claim to the native parent specification and intended integration branch, then records verified ticket integration and recomputes dependent readiness. Workers send results to the controller; only the common serialized tracker publishes progress. See the concrete commands and evidence requirements in [agent-tracking.md](agent-tracking.md#implementation-reporting-checkpoints).

During implementation and review, follow the [genuine activity procedure](agent-tracking.md#genuine-activity-and-independent-freshness): obtain a worker-specific message or actual run observation, retain its original UTC time, and sample extended work at the five-minute publication cadence. Report known waiting/stopped workers promptly. When observation is unavailable, leave activity unverified; the independent Actions evaluator ages confirmations after the conversation ends without changing ownership or review/takeover authority.

At every handoff, preserve the exact reviewed revision, focused-check results, distinct reviewer identity, Standards/Spec outcomes and independent-context attestation. Review waiting is inactive; confirm a working reviewer only from an actual reviewer observation. Hard findings return to Implementace. Clean review applies to the precise reviewed tip; later code needs applicable review. Publish integration only after actual Git incorporation into the bound integration branch, with its commit and clean review evidence.

A still-open internal blocker can unblock a dependent only after clean review and integration into this specification's same integration context. All blockers must be satisfied. External blockers retain the actual final-merge requirement; closing an issue without delivery or integration into another effort is insufficient. Keep native dependency edges and implementation issues open until the final PR merges. Readiness does not start workers or replace the following review gates. Record concrete obstacles with reason, reference, resumption condition and phase; resume from observed resolution. Missing activity alone is not blockage or cancellation.

Follow the [iVAT Agent implementation Project](https://github.com/users/Thomisso/projects/1) and the [shared tracker commands](agent-tracking.md). Approved backlog membership is automatic; use `npm run agent:track -- discover --parent <spec>` for immediate reconciliation and the native Parent table filter. Discovery is passive: the controller must still acquire ownership and explicitly claim implementation work. Text-only parent fallbacks remain linked from the specification's maintained tracking overview.

## Integration loop

1. Create an integration branch from the target branch. After its first ticket merge, push it and open a draft pull request with closing references for the spec and child tickets.
2. Give each ready ticket its own branch and worktree based on the current integration tip. The implementer runs the ticket's focused tests, typecheck and lint, then merges the latest integration tip into its branch.
3. Report the completed implementation and focused checks with the exact revision through `review`. Give the ticket, its base commit and its diff to a reviewer with no implementation context. The reviewer checks both `CODING_STANDARDS.md` and the ticket. Hard standards or spec findings return to the same implementer; the ticket is mergeable only when none remain.
4. Merge the precise reviewed ticket tip into the integration branch, push the relevant branches for worker corroboration, then report `integrate` with the actual merge commit and `readiness` for newly unblocked dependents. Regenerate database types when migrations changed, then start the next newly unblocked ticket.

## Test budget

Parallel ticket worktrees run focused test files. They do not run competing full database suites: every worktree owns a Supabase stack, but all stacks still compete for the same Docker resources.

After all ticket merges and review fixes:

1. Stop the ticket worktrees' Supabase stacks.
2. On the integration branch, run `npm run test:serial`, `npm run typecheck`, `npm run lint`, `npm run build` and the relevant runtime/E2E checks.
3. Review the combined diff against the full spec. Cross-ticket findings return to one fix branch and the final checks repeat on the resulting integration commit.
4. Bind the actual final PR with `final-pr`, report the exact resulting revision through `final-checks` and `final-review`, complete `sync`, then use `final-handoff` for the actual ready transition. Follow the [final evidence commands](agent-tracking.md#final-checks-handoff-and-delivery); queued/partial synchronization or outdated/failed/missing gates refuse handoff. The final human PR merge closes its referenced implementation issues; shared reconciliation verifies the result and current closure before Hotovo. Tracking neither merges nor deploys.

Standalone handoff uses the same final commands with its configured focused/relevant-runtime gates and existing independent review, without inventing an integration branch. Explicit cancellation, manual display conflicts, reopen and registered reversals follow [the shared control procedure](agent-tracking.md#cancellation-manual-conflicts-and-reversed-delivery). Stop/interruption preserves phase. A final merge after the conversation ends is reconciled by the trusted shared worker. Initial installation activates only after full integration reaches the default branch; do not bootstrap a partial production writer.
