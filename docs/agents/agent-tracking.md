# Agent progress in GitHub

Use `npm run agent:track -- <command>` when reporting implementation work. The tracker separates reached implementation phase, verified agent activity and the latest result. The triage labels retain their existing issue-readiness meaning.

Use the [iVAT Agent implementation Project](https://github.com/users/Thomisso/projects/1) for approved implementation work, including waiting tickets and their specification context. Membership discovery and explicit claims share one serialized publication path. The remaining #200 tickets add review/integration, comprehensive recovery, independent freshness checks and final completion gates; membership alone does not attest those capabilities.

## Setup

1. Select one GitHub Project owned by the repository owner and one dedicated registry issue in that repository. The registry stores a small technical snapshot in one maintained comment; it does not contain credentials or private Documents. Existing implementation issues are referenced in the Project, never copied.
2. Authorize local `gh` for Projects writes with `gh auth refresh --scopes project`. Keep its credential in the GitHub CLI credential store. Configure `AGENT_TRACKER_TOKEN` as a repository Actions secret with the Projects and repository access required for this user-owned Project; the ordinary repository `GITHUB_TOKEN` cannot access Projects. The local credential and Actions secret are separate setup requirements.
3. Select the existing Project and registry explicitly:

   ```sh
   npm run agent:track -- setup --repo OWNER/REPO --owner OWNER --project-number NUMBER --registry-issue NUMBER
   ```

   Setup checks actual repository/project/field identities and creates missing tracking fields plus the initial maintained registry comment. Existing single-select option identities are preserved. It fails if enabled native workflows could change progress independently. On a dedicated selected Project, explicitly pass `--disable-native-workflows` to remove its enabled native workflows. Inspect the selected Project before authorizing that option; it is not a global setting.

4. Commit the generated non-secret configuration together with the tracker code and workflow. To verify another selected repository use `--config PATH` on each command. `doctor` verifies actual remote fields, options, registry and absence of enabled competing workflows; a configuration file by itself is not proof that setup succeeded.
5. The workflow must exist on the repository's default branch before GitHub accepts dispatches. Before this implementation merges, use a dedicated private acceptance repository with tracker code/workflow on its default branch and a separate Project, registry and synthetic issues. Do not edit the human's application branch to activate testing.

## Approved backlog membership

Run initial discovery after setup and after the workflow/configuration reach the selected repository's default branch:

```sh
npm run agent:track -- discover
# Optionally save the table's native parent filter for this specification:
npm run agent:track -- discover --parent 200
npm run agent:track -- show
```

Discovery selects all pages of open issues labelled `ready-for-agent`, adds references to those implementation issues and their parent context, and excludes previously untracked closed history. Specification-shaped bodies (Problem Statement, Solution and User Stories), or issues with sub-issues, are context records without implementation Status. Standalone ordinary issues can be implementation work. Native parents take precedence over body text. Without a native parent, use exactly one `Part of #N` declaration at the opening of the issue or in its `## Parent` section; arbitrary references elsewhere do not establish a parent. Malformed or conflicting declarations leave the ticket blocked with a diagnostic. A missing referenced parent refuses discovery for repair rather than inventing a relationship.

Previously untracked implementation items start inactive. They are Připraveno only when their implementation dependencies are verified clear; native dependency edges are canonical when available. Only if that endpoint is unavailable does discovery use an opening `Blocked by: #N` fallback line. Referenced dependencies remain Blokováno until delivery evidence is verified by the lifecycle policy; a closed issue, including a not-planned closure, does not itself prove final delivery. Unknown or unsatisfied dependencies are Blokováno. Discovery neither claims a controlling run nor starts an implementer. It refreshes observed parent relationship metadata while preserving existing phases, ownership, activity, results, attested integration context, evidence and timestamps; labels removed later, closure and terminal phases do not remove tracked history. It never changes triage labels.

The same Actions `publish` job also discovers work for issue opened/edited/labelled/reopened/closed/transferred events and an hourly membership reconciliation at minute 17. The hourly path is independent of activity freshness checks. GitHub may delay schedules; an explicit `discover` can reconcile immediately. Changes made using the repository `GITHUB_TOKEN` may not generate another workflow run, so the periodic path also repairs missed issue triggers. The configured token needs repository Issues write, Actions read/dispatch and Projects write access, including any cross-repository parent context. Keep `AGENT_TRACKER_TOKEN` in Actions secrets and local `gh` authentication in its credential store. Missing permissions are failures, never successful setup. Native Project auto-add/close workflows remain disabled. The registry retains the latest 32 published automatic membership wakeup receipts; replaying an older automatic wakeup recomputes current passive discovery. Pending events and all manual/controller acknowledgments remain durable and are never pruned by this policy.

The worker reconciles two named views without creating issue copies: **Agent implementation**, a board filtered with `has:status`, and **Agent specification**, a table exposing native Parent issue and the same implementation fields. View IDs and readback live in the canonical registry (`remote.views` in `show`); optional versioned `views.board` / `views.table` IDs pin existing intended views. Unique names recover a create whose response was lost; ambiguous names refuse publication. `discover --parent N` saves `parent-issue:"OWNER/REPO#N"` in the table. Clear that table filter to inspect all retained context and work.

GitHub's documented view mutation has no group-by input. After initial discovery, inspect **Agent implementation** in the Project UI, choose **Group by → Status**, and save the view if necessary. Run discovery again and require `remote.views.board.groupingVerified: true` from actual readback before claiming the board is configured. A synchronized membership receipt alone does not prove that UI-only setting. See the [GitHub Projects API contract](https://docs.github.com/en/graphql/reference/projects#projectv2viewconfigurationinput).

Native Parent filtering includes native relationships. A text-only fallback does not populate that built-in field. Each specification's one maintained tracking comment explicitly lists and links its fallback children, explains this limitation, and directs the maintainer to those tracked issues or the table with its filter cleared. To make them appear under the native filter, establish the native sub-issue relationship using the issue-tracker procedure; discovery does not silently rewrite relationships or create a competing custom Parent text field. The same maintained specification comment supplies the Project link without rewriting the issue body or appending duplicate links.

## First ticket path

```sh
npm run agent:track -- doctor
npm run agent:track -- start --run qa-200-controller
npm run agent:track -- claim --issue 201 --agent implementer-201 --branch feat/agent-tracking-201 --result 'Implementation started'
npm run agent:track -- show
npm run agent:track -- sync
```

The branch must be an existing local branch with an actual commit. It need not already be pushed. Its observed tip is recorded with the claim. The responsible GitHub account comes from the authenticated dispatch actor; the implementing agent is a separate identity. A claim does not manufacture a verified-activity observation.

Commands write their bounded event envelopes to a durable journal under the shared Git common directory before dispatching. Linked worktrees share this journal and its local process lock. Runtime state is not committed to any branch. Each event has a UUID, controlling-run identity, generation, ordered sequence and original UTC timestamp. Only the fixed-concurrency Actions worker writes canonical registry state and Project fields; local commands never race it with direct phase writes.

The worker reads current registry state when execution starts, validates ownership and records intended state before publishing Project fields and the maintained ticket comment. It acknowledges the projected revision only after every required effect succeeds. Dispatch acceptance or workflow success alone is not synchronization proof. An already owned run may retain local pending work during an outage; `publication_pending` is a refusal to claim successful publication, not a claim that the queued work was lost. Use `show` after access returns and `sync` to retry the same event identity. `--wait-seconds N` bounds acknowledgment polling (default 120, maximum 600).

The local journal also retains the last confirmed remote snapshot, including discovered context, selected tickets and their published state. `show --local` reads this snapshot and pending intents without contacting GitHub; it does not claim the remote state is still current.

Starting a second controlling run is refused, including from another linked worktree. No heartbeat timeout releases ownership. Full explicit stop/resume/takeover is supplied by the recovery ticket, not by deleting a lock or changing a Project field. Keep review, integration, test-budget and eventual final-handoff rules in the existing implementation workflow.

## Verification

`npm run test:agent-tracker` exercises the real commands in separate processes and isolated Git worktrees, controlling only the external `gh` boundary. `node scripts/verify-agent-tracker-transport.mjs` additionally drives real `gh` HTTPS through a stateful Postman GitHub simulation with a disposable synthetic token. The simulation exercises serialization, error mapping, partial effects, retries and original observation times; it does not prove actual Actions concurrency or upstream Projects permissions.

The registry uses a conservative 48 KiB application limit. Capacity failure refuses acknowledgment rather than truncating state. GitHub does not offer one atomic transaction covering Project fields, issue comments and the registry: partial publication remains unsynchronized and repairable. All supported writers use the same repository-wide Actions concurrency group with `cancel-in-progress: false`. External forced cancellation or ambiguous server-side execution must not be described as a universal atomicity guarantee.

Publish only technical progress and necessary repository references. Never pass credentials, sessions, private Documents or debug dumps as result text. Expected errors are structured JSON codes; raw provider error bodies are not emitted.
