# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (database id, as in **Blocking** below). Without sub-issues, put `Part of #<parent>` at the top of the child body.
- **Comment on an issue**: pass Markdown through stdin so shell syntax stays literal:

  ```bash
  gh issue comment <number> --body-file - <<'EOF'
  Markdown, including `code`, stays literal here.
  EOF
  ```

- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close non-code work**: comment with the stdin form above, then run `gh issue close <number>`.

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## Implementation reporting

Both standalone `implement` and multi-ticket `implement-spec` use [agent-tracking.md](agent-tracking.md#implementation-reporting-checkpoints). The owning controller reports claim, completed implementation/focused checks, exact-revision independent review, findings/fixes, actual integration and explicit blockage/resumption through the shared command boundary. Workers supply evidence to the controller. Native assignee identifies the responsible GitHub account; implementing/reviewer agent identities remain separate.

Use the [genuine activity procedure](agent-tracking.md#genuine-activity-and-independent-freshness) for worker messages/run observations, original UTC times, the five-minute confirmation cadence and known waiting/stopped states. Missing verification leaves activity unverified. The independent Actions observer retains phase and ownership after the conversation ends; ageing is never takeover or review authority.

Within one specification and integration context, clean independent review plus verified integration can satisfy a blocker while its implementation issue remains open. Every other unsatisfied blocker remains effective. External dependencies require actual final delivery by the current closing PR merged into its final target; the open-blocker count alone is insufficient. Preserve dependency edges, issue closure rules and the final combined-check/review gates in [implementation-workflow.md](implementation-workflow.md). A readiness projection never launches work.

## Implementation visibility

The [iVAT Agent implementation Project](https://github.com/users/Thomisso/projects/1) references original approved implementation issues and parent specifications. Issue events and an hourly serialized reconciliation add open `ready-for-agent` work, then retain it when labels change or issues close. This does not change the labels' readiness meaning. Use [shared tracker guidance](agent-tracking.md) for discovery, native Parent filtering and the explicit links for text-only parent fallbacks.

## Implementation closure

Repository automatic issue-closing configuration and its verification record belong to [tracker setup](agent-tracking.md#repository-automatic-issue-closing). Implementation uses that setup record and the final PR evidence below.

Code issues stay open while their branch is under review. Put `Closes #<number>` in the pull request body so GitHub closes them when the pull request merges. A multi-ticket integration pull request names the spec and every completed child ticket. Research, triage and other work without a code merge is resolved by commenting and closing the issue directly. Such closure is not delivered implementation. Both implementation flows bind/report final revision checks and independent review, synchronize and use `final-handoff` for PR readiness. Only shared evidence-backed reconciliation of actual final merge/current closure publishes Hotovo. See [final handoff and delivery](agent-tracking.md#final-checks-handoff-and-delivery). Explicit `cancel` requires a reason and publishes Zrušeno; stop/interruption preserves phase. Project field edits cannot control work. Reopening and explicitly registered reversals invalidate obsolete delivery through [the shared reconciliation procedure](agent-tracking.md#cancellation-manual-conflicts-and-reversed-delivery), without launching agents.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see **Make an issue a sub-issue of a parent**). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. For triage/frontier work, a ticket is unblocked when every blocker is closed. Implementation readiness uses the evidence-backed internal-versus-external rule above; issue closure by itself does not prove final delivery.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
