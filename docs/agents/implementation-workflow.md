# Multi-ticket implementation

Use this workflow when one spec is implemented through parallel tickets. Its completion criterion is one reviewable integration pull request whose child diffs and combined behavior have both passed review.

Follow the [iVAT Agent implementation Project](https://github.com/users/Thomisso/projects/1) and the [shared tracker commands](agent-tracking.md). Approved backlog membership is automatic; use `npm run agent:track -- discover --parent <spec>` for immediate reconciliation and the native Parent table filter. Discovery is passive: the controller must still acquire ownership and explicitly claim implementation work. Text-only parent fallbacks remain linked from the specification's maintained tracking overview.

## Integration loop

1. Create an integration branch from the target branch. After its first ticket merge, push it and open a draft pull request with closing references for the spec and child tickets.
2. Give each ready ticket its own branch and worktree based on the current integration tip. The implementer runs the ticket's focused tests, typecheck and lint, then merges the latest integration tip into its branch.
3. Give the ticket, its base commit and its diff to a reviewer with no implementation context. The reviewer checks both `CODING_STANDARDS.md` and the ticket. Hard standards or spec findings return to the same implementer; the ticket is mergeable only when none remain.
4. Merge the reviewed ticket into the integration branch. Regenerate database types when migrations changed, then start the next newly unblocked ticket.

## Test budget

Parallel ticket worktrees run focused test files. They do not run competing full database suites: every worktree owns a Supabase stack, but all stacks still compete for the same Docker resources.

After all ticket merges and review fixes:

1. Stop the ticket worktrees' Supabase stacks.
2. On the integration branch, run `npm run test:serial`, `npm run typecheck`, `npm run lint`, `npm run build` and the relevant runtime/E2E checks.
3. Review the combined diff against the full spec. Cross-ticket findings return to one fix branch and the final checks repeat on the resulting integration commit.
4. Mark the draft pull request ready. The pull request merge closes its referenced implementation issues.
