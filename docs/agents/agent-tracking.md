# Agent progress in GitHub

Use `npm run agent:track -- <command>` when reporting implementation work. Apply the [CLI process and evidence rules](cli-processes.md) to setup, observation and delivery. The tracker separates reached implementation phase, verified agent activity and the latest result. The triage labels retain their existing issue-readiness meaning.

Use the [iVAT Agent implementation Project](https://github.com/users/Thomisso/projects/1) for approved implementation work, including waiting tickets and their specification context. Membership discovery, explicit claims, durable recovery and ticket lifecycle commands share one serialized publication path. Lifecycle evidence records independent review, verified integration and dependency readiness. Independent activity freshness uses the same writer. Final specification completion gates require their own acceptance evidence.

## Setup

1. Select one GitHub Project owned by the repository owner and one dedicated registry issue in that repository. The registry stores a small technical snapshot in one maintained comment; it does not contain credentials or private Documents. Existing implementation issues are referenced in the Project, never copied.
2. Use an existing local `gh` credential with Projects write access; check authentication with `gh auth status` and rely on `setup`/`doctor` for actual access. An already-issued token with the required resource access can be supplied privately as `GH_TOKEN` from a protected input or secret store; keep it out of process arguments, reports and versioned files. Missing credentials/scopes are a precise setup limitation, not a reason to launch interactive web authentication. Configure `AGENT_TRACKER_TOKEN` through `gh secret set AGENT_TRACKER_TOKEN --repo OWNER/REPO < PROTECTED_TOKEN_FILE` as a repository Actions secret with the Projects and repository access required for this user-owned Project; the ordinary repository `GITHUB_TOKEN` cannot access Projects. The local credential and Actions secret are separate setup requirements.
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

The same Actions `publish` job also discovers work for issue opened/edited/labelled/reopened/closed/transferred events and an hourly membership reconciliation at minute 17. The hourly path is independent of activity freshness checks. GitHub may delay schedules; an explicit `discover` can reconcile immediately. Changes made using the repository `GITHUB_TOKEN` may not generate another workflow run, so the periodic path also repairs missed issue triggers. The configured token needs repository Issues write, Actions read/dispatch and Projects write access, including any cross-repository parent context. Keep `AGENT_TRACKER_TOKEN` in Actions secrets and local `gh` authentication in its credential store. Missing permissions are failures, never successful setup. Native Project auto-add/close workflows remain disabled. The registry retains the latest 32 published automatic membership wakeup receipts; replaying an older automatic wakeup recomputes current passive discovery. This discovery policy does not prune manual/controller receipts. Their separate 32-terminal-receipt ring protects pending outcomes and the current ordered owner/stop cursor as described in Recovery below.

The worker reconciles two named views without creating issue copies: **Agent implementation**, a board filtered with `has:status`, and **Agent specification**, a table exposing native Parent issue and the same implementation fields. View IDs and readback live in the canonical registry (`remote.views` in `show`); optional versioned `views.board` / `views.table` IDs pin existing intended views. Unique names recover a create whose response was lost; ambiguous names refuse publication. `discover --parent N` saves `parent-issue:"OWNER/REPO#N"` in the table. Clear that table filter to inspect all retained context and work.

After initial discovery, run `npm run agent:track -- show` and require `remote.views.board.groupingVerified: true` from actual `verticalGroupByFields` API readback: board columns use that axis, independently of horizontal grouping. A newly created board may already have Status columns. If verification is false, preserve the failed/unverified result and identify the exact view and expected Status field. Check the supported [GitHub Projects API contract](https://docs.github.com/en/graphql/reference/projects#projectv2viewconfigurationinput) through HTTP or `gh api`; correct grouping only if the current API supports that operation and then repeat discovery/readback. The tracker currently records grouping but does not configure that axis. If the API lacks a supported setter, report that precise capability gap; do not request a UI edit or claim successful column verification. A synchronized membership receipt alone does not verify the board's columns.

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

Starting a second controlling run is refused, including from another linked worktree. No heartbeat timeout releases ownership. Keep review, integration, test-budget and eventual final-handoff rules in the existing implementation workflow.

## Genuine activity and independent freshness

Before confirming a worker, receive a message from that identified implementer/reviewer or inspect its actual run state. Record that original UTC time, then use the shared boundary:

```sh
npm run agent:track -- activity --issue TICKET --agent WORKER --role implementer --state working --source run_observation --observed-at ORIGINAL_UTC --reference 'Worker run observed running focused checks'
npm run agent:track -- activity --issue TICKET --agent WORKER --role implementer --state waiting --source agent_message --observed-at ORIGINAL_UTC --reference 'Worker reports waiting for review input'
npm run agent:track -- observe-activity
```

Use `agent_message` for an actual message from that worker, and `run_observation` for an actual inspection of its run. Use `reviewer` only after `review-start` identifies the current reviewer. `review-start --observed-at ORIGINAL_UTC` accepts a delayed genuine reviewer message; omitting the option attests an immediate observation at the command's original event time. Original times use canonical UTC ISO 8601 with milliseconds, such as `2026-11-05T12:00:00.000Z`. The controller attests the source honestly; a command cannot prove the observation by itself. Keep references bounded and technical, excluding session identifiers, local paths, credentials and raw tool output.

During extended work, obtain a fresh worker observation at least five minutes after its last successful confirmation publication. The worker adopts at most one activity confirmation per ticket in that interval. A suppressed sample returns `outcome: throttled` and does not delay subsequent phase reports. Equal or older observations cannot replace a newer confirmation or refresh its publication clock, including a delayed delivery with a new event identity. `show` exposes `activityAt` and `activityObservation` for the original observation, `activityPublishedAt` for successful publication, and `stateAt` for phase evidence. A failed projection never establishes the successful publication clock. Retries preserve the original observation.

Report observed `waiting` or `stopped` promptly with the same source/time/reference fields. These states preserve ownership and the reached phase while making activity inactive. A later genuine working observation can resume that worker within its current permitted role; it cannot revive a prior handoff, historical run, blocked or integrated phase. Claim alone is unverified. Review handoff, clean review, blockage, integration, completion/cancellation and tickets without a working agent are inactive. A confirmation proves neither useful progress nor correct implementation or successful checks.

When the controller cannot genuinely verify a worker, leave its activity unverified and retain its last original confirmation time. A timer, successful GitHub write, unchanged phase or resumed conversation supplies no observation. Do not release ownership or start replacement workers because a confirmation ages.

After the conversation ends, the independent Actions schedule evaluates freshness every five minutes through the existing fixed-concurrency `publish` job. `observe-activity` is also an immediate passive wakeup from a separately configured clone with no owned journal. Each wakeup recomputes from the latest canonical records at worker execution time; it contains no old snapshot to overwrite newer confirmations or superseding runs. Confirmations become unverified when strictly older than 15 minutes; exactly 15 minutes remains confirmed. The phase, latest result, evidence, original timestamp and ownership remain intact. Repeated unchanged evaluations acknowledge without rewriting ticket fields/comments. A prior incomplete projection is still repaired.

Detection occurs on the next successful evaluator execution after expiry, usually with up to another five-minute cadence plus queue and Actions delay. Scheduled workflows can start late or be skipped; this is not a hard 15-minute detection guarantee. An old inactive ticket is not a stalled worker. The observer only evaluates activity: review approval, integration, Hotovo, takeover and launching workers still require their existing authorities and evidence. Membership discovery retains its separate hourly schedule.

Actions use versioned repository/project/field/workflow identities from the selected configuration and the separately authorized repository secret `AGENT_TRACKER_TOKEN`, passed only as `GH_TOKEN`. The worker refuses a missing secret as `actions_credential_missing`; the ordinary `GITHUB_TOKEN` and local `gh` login do not substitute. Configure an already-issued token through `gh secret set AGENT_TRACKER_TOKEN --repo OWNER/REPO < PROTECTED_TOKEN_FILE`, granting the selected user-owned Project and repository/Actions/Issues access described above. A secret-name listing proves presence only; the isolated worker execution must establish actual access. Keep tokens out of configuration and progress output. Run `doctor` for local configuration/access and an isolated Actions `observe-activity` for actual Actions credential validation. `configuration_missing`/configuration identity errors, `github_permission_denied` and `github_connection_failed` distinguish setup/access from transport failure. A manual dispatch demonstrates independent execution, while observed scheduled execution is separate evidence; record which actually occurred in [agent-tracking-acceptance.md](agent-tracking-acceptance.md).

## Stop, resume and explicit recovery

After stopping the run's workers through the orchestration tools, release its ownership explicitly:

```sh
npm run agent:track -- stop --reason 'Controller work stopped'
npm run agent:track -- resume --run qa-200-controller
```

Stopping records a validated ended-owner history and leaves reached phases and review/integration evidence intact. Its tickets become inactive. Resuming a stopped run acquires a new generation; it does not silently restart its former workers. Deliberately claim a historical inactive ticket again with the intended agent and real local branch to transfer it to the new owner. Its reached phase and prior review/integration evidence remain associated with their original revisions. A claim preserving review or integration requires that exact reviewed branch tip, including when an obstacle blocks that phase; a changed tip is refused as `historical_revision_mismatch` and leaves the existing evidence intact. A renamed branch at the same tip is allowed. Reclaimed implementation becomes unverified until genuinely observed; review waiting, clean review, integration and other inactive phases stay inactive.

Use the current tracker CLI when recovering a ticket whose branch predates a tracker upgrade. Run the current checkout's `scripts/agent-tracker.mjs` by absolute path from the recovery worktree if necessary, so the old branch's CLI does not try to read newer registry state.

For a controller interrupted on the same computer, `resume` requires the original durable journal and matching current remote ownership. It completes pending FIFO publication, checks available issue, local Git, remote commit and PR facts, and republishes the known tickets to repair missing Project membership. Missing facts are reported as unverified evidence; they do not invent completed implementation or a new phase. A resumed conversation is not itself proof that a worker is active.

Another clone/computer cannot attach itself to a live generation merely by knowing its run ID. Use the explicit recovery procedure:

```sh
npm run agent:track -- resume --recover --run qa-200-controller --reason 'Explicit recovery on replacement computer'
```

This verifies the expected remote run and account, archives its prior ownership, and increments the generation even if the logical run ID stays the same. It reconstructs published/Git facts and marks local-only unpublished history as not recovered. It cannot recover events that never left the original computer. Old-generation clients receive `run_superseded`; their pending intents are retained in the local journal's superseded record rather than being silently applied to the replacement run. They must stop acting as the controller.

To deliberately replace a differently named live run, name the exact observed owner and generation:

```sh
npm run agent:track -- takeover --from-run qa-200-controller --from-generation 2 --run qa-200-replacement --reason 'Explicit controller replacement'
```

Ownership must be verifiable and the authenticated account must match the responsible account. A changed generation, unavailable registry or malformed ownership refuses takeover. Only an explicit validated stop establishes free ownership after an earlier generation; missing owner fields or old timestamps do not.

`sync` rereads current canonical state, checks the caller's generation, and checks every pending projection before reporting `synchronized: true`. A failed dispatch response is ambiguous: the persisted UUID is retried or acknowledged from the registry, rather than assumed absent. Older asynchronous snapshots cannot replace a newer locally known revision. `repair` forces actual idempotent projection of the latest canonical facts through the serialized worker even when no implementation revision changes. It neither owns work nor changes phase; it is also the repair path for an incomplete projection.

Local process locks are shared by linked worktrees. Host verification accepts the exact kernel hostname; on macOS it also accepts the exact current system LocalHostName followed by `.local`, read through a bounded OS lookup. Missing or malformed OS names add no alias. A lock is reclaimed only when its recorded local PID is demonstrably gone, under a separate reclaimer election; a live, foreign-host, partial or otherwise unverified owner remains refused. There is no age-based lock removal. Killing the controller and removing its disposable worktree leaves the durable outbox in the Git common directory for recovery.

## Implementation reporting checkpoints

The controller uses these commands for both standalone `implement` and multi-ticket `implement-spec`. Workers report their identity, observations, exact revision and results to that controller; they do not become competing Project writers. Commands attest observed work, not merely a worker's unsupported completion claim. Keep focused tests in each ticket worktree and the independent review and later combined-check gates in [implementation-workflow.md](implementation-workflow.md).

For standalone work, claim with the first-ticket command above and omit integration context. For multi-ticket work, bind the ticket to its actual parent and the specification's intended integration branch:

```sh
npm run agent:track -- claim --issue TICKET --agent IMPLEMENTER --branch WORK_BRANCH --spec SPEC --integration-branch INTEGRATION_BRANCH --result 'Implementation started'
npm run agent:track -- review --issue TICKET --base BASE_SHA --revision REVIEWED_SHA --checks 'Focused tests, typecheck and lint passed on this revision' --result 'Implementation and focused checks complete'
npm run agent:track -- review-start --issue TICKET --reviewer REVIEWER --result 'Reviewer reports inspecting the ticket and diff'
npm run agent:track -- review-result --issue TICKET --reviewer REVIEWER --revision REVIEWED_SHA --standards pass --spec pass --findings '[]' --independence 'Reviewer received ticket, base and diff without implementation context' --result 'No remaining hard findings'
npm run agent:track -- integrate --issue TICKET --integration-commit MERGE_SHA --result 'Reviewed ticket incorporated into the specification integration branch'
```

`review` is the controller's attestation that implementation and the named focused checks completed successfully on the identified revision. Supply genuine check results. Handoff makes activity inactive while waiting; only `review-start`, reporting a specific reviewer's actual observation, confirms a working reviewer. `review-result` records that reviewer's Standards and Spec outcomes and independence attestation. Use `fail` and a JSON array of meaningful hard findings to return to Implementace. Fixes require another handoff and applicable review. A result for an old reviewed ancestor cannot approve later code. A clean standalone review stays in Review; it does not manufacture an integration branch or final completion.

Push the relevant working branch before review publication and the intended integration branch before integration publication so Actions can corroborate their actual commit facts. Local Git validates exact tips, ancestry and an automatic merge's tree; the authority also verifies remote branch history, commit parents and tree. A conflict resolution or changed merge tree requires renewed applicable review. Unpublished evidence stays durably pending until it can be corroborated. Dispatch acceptance alone never proves publication.

After integrating a blocker, recompute each known dependent through the same controller:

```sh
npm run agent:track -- readiness --issue DEPENDENT --spec SPEC --integration-branch INTEGRATION_BRANCH
npm run agent:track -- block --issue TICKET --reason 'Concrete missing input or obstacle' --reference 'https://github.com/OWNER/REPO/issues/BLOCKER' --condition 'Observable condition for continuing' --result 'Waiting for the identified input'
npm run agent:track -- resume-phase --issue TICKET --resolution 'Observed evidence that the condition is met' --result 'Work can continue'
```

Readiness checks all [native blocker pages](https://docs.github.com/en/rest/issues/issue-dependencies), including closed issues. A still-open internal blocker is satisfied by independent clean review plus actual integration into the same parent's same integration context. External evidence uses [closedByPullRequestsReferences and the actual ClosedEvent](https://docs.github.com/en/graphql/reference/issues), including closed PR references and pagination. Every external blocker requires the current closure to reference an actually merged PR into its repository's final target (normally the default branch), with the merge commit in that target's history. An arbitrary historical closing reference or merge into an unrelated integration branch is insufficient. Keep the native dependency edges and implementation issues open until final delivery. The documented opening `Blocked by:` fallback applies only when native dependencies are unavailable; access failures do not mean zero blockers.

Readiness projects only waiting/dependency-blocked work and never launches workers, rewinds active phases or clears explicit obstacles. Explicit blockage preserves its reason, reference, condition and justified resumption phase; resumption records observed resolution and rechecks revision evidence. Missing heartbeats do not create blockage. Ticket integration does not establish whole-specification completion or bypass final combined checks/review and PR handoff.

## Verification

`npm run test:agent-tracker` exercises the real commands in separate processes and isolated Git worktrees with a controlled external `gh` boundary. The host-identity cases additionally control OS hostname/platform and the bounded macOS `scutil` lookup; PID liveness, subprocesses, filesystem locks and Git remain real. Those cases prove recovery policy under the supplied OS observations, not live macOS alias discovery on every host. `node scripts/verify-agent-tracker-transport.mjs` additionally drives real `gh` HTTPS through a stateful Postman GitHub simulation with a disposable synthetic token. The simulation exercises serialization, error mapping, partial effects, retries and original observation times; it does not prove actual Actions concurrency or upstream Projects permissions.

The registry retains a ring of 32 terminal manual receipts, plus the current owner's latest ordered outcome (or the latest explicit stop), and all pending outcomes. Automatic discovery has its separate bounded published-receipt window. FIFO clients durably consume an acknowledgment before sending the next owned sequence; passive retries whose old receipt was pruned recompute current facts instead of replaying an old snapshot. A table selection from `discover --parent N` also carries the verified selection revision: an old retry cannot replace a newer selection. `selection_superseded` requires a freshly queued selection command. An unknown old owned acknowledgment is never treated as success or reinterpreted as a new phase event.

The registry retains its `ivat-agent-tracker:registry:v1` marker and logical schema. Small snapshots remain plain JSON. When plain JSON would exceed the comment bound, the JSON block instead holds a `gzip-base64-v1` representation with `registryEncoding`, `decodedBytes`, `sha256` (of the decoded UTF-8 JSON bytes) and base64 `data`. Readers accept both representations without migration. Gzip integrity, canonical base64, exact decoded byte count, SHA-256, UTF-8 and the existing logical schema are validated before use. Decoding is limited to 4 MiB, including when an envelope understates its size; rendering refuses larger decoded snapshots. Compression preserves all fields and evidence, but growth remains bounded by both decoded and rendered limits. Capacity or corruption refuses acknowledgment rather than pruning evidence.

The registry uses a conservative 60 KiB application limit measured over the complete rendered UTF-8 body, including its marker and JSON wrapper. An isolated actual GitHub API round-trip verified a 61,440-byte comment body. Pending intents, controlling history and active evidence are not silently truncated when it fills; capacity failure refuses acknowledgment. GitHub does not offer one atomic transaction covering Project fields, issue comments and the registry: partial publication remains unsynchronized and repairable. All supported writers use the same repository-wide Actions concurrency group with `cancel-in-progress: false`. External forced cancellation or ambiguous server-side execution must not be described as a universal atomicity guarantee.

Publish only technical progress and necessary repository references. Never pass credentials, sessions, private Documents or debug dumps as result text. Expected errors are structured JSON codes; raw provider error bodies are not emitted.

## Final checks, handoff and delivery

The specification's maintained overview shows native/fallback child counts separately from shared checks, combined Standards/Spec review and the actual final PR state. An untracked, cancelled or unintegrated child prevents final specification handoff. Integrated totals alone never establish whole-specification readiness. The same final commands cover standalone work without an integration branch. Foreign parent issues retain their qualified identity and original links as context only; this repository's controller does not publish child counts or final gates for another repository, and never substitutes a same-number local specification.

Bind the actual final PR, then attest observed checks and independent combined review on its exact resulting revision:

```sh
npm run agent:track -- final-pr --issue ISSUE_OR_SPEC --pr FINAL_PR --result 'Final PR opened for the resulting change'
npm run agent:track -- final-checks --issue ISSUE_OR_SPEC --revision EXACT_SHA --checks '[{"name":"test:serial","status":"passed","evidence":"Actual technical result or check URL"},{"name":"typecheck","status":"passed","evidence":"Actual result"},{"name":"lint","status":"passed","evidence":"Actual result"},{"name":"build","status":"passed","evidence":"Actual result"},{"name":"runtime","status":"passed","evidence":"Actual relevant runtime/E2E result and applicability"}]' --result 'Controller reports actual shared check outcomes'
npm run agent:track -- final-review --issue ISSUE_OR_SPEC --revision EXACT_SHA --reviewer INDEPENDENT_AGENT --standards pass --spec pass --findings '[]' --independence 'Reviewer received the whole spec, base and combined diff without implementation context' --evidence 'Actual review reference' --result 'No remaining hard findings'
npm run agent:track -- sync
npm run agent:track -- final-handoff --issue ISSUE_OR_SPEC --result 'Required synchronization, checks and independent review complete'
```

The sample shared gates apply to an iVAT specification. Versioned `.github/agent-tracking.json` declares the required names in `finalChecks.specification` and `finalChecks.standalone`. iVAT standalone gates are `focused`, `typecheck`, `lint`, `runtime`. An isolated tracker-only acceptance repository must explicitly configure its genuine applicable gates (for example `tracker-tests`, `syntax`, `diff`), rather than claiming iVAT application commands ran on different code. These names describe evidence requirements; the tracker never executes arbitrary commands. Report `failed` or `outstanding` honestly. Missing names remain outstanding, and skipped native checks/green aggregate rollups cannot replace the required attestations. Record actual relevant runtime verification or an explicit justified applicability result, never a fabricated pass. Keep evidence technical, bounded and linked where available.

Both sanctioned implementation flows use `final-handoff` for the actual ready transition, instead of calling `gh pr ready` directly. It refuses queued local updates, incomplete prior remote projection, failed/missing checks or independent review, wrong PR target and changed revisions. Its intent is durable before the effect; all required Project/comment projections finish before the serialized worker marks the actual PR ready. A response lost after readiness may leave the intent pending; sync reads actual draft state and finishes without repeating the transition. Do not treat dispatch acceptance or already-ready state as evidence of a successful handoff. GitHub's ready mutation has no expected-head guard: the writer checks immediately before and after, refuses mismatched applicability and restores draft when its own transition observes a race. The possible ready effect is durably marked before mutation; failed or response-lost draft restoration stays pending and is retried under the same owner, generation and bound PR identity before terminal refusal. The final observed head/target is checked even when a retry finds the PR already ready. Tracker serialization cannot make unrelated human writes atomic with GitHub's mutation.

Before and after readiness, including already-ready retries, the current default-target tip must be an ancestor of the checked PR head. Otherwise `final_target_changed` refuses handoff and any possible owned ready effect is compensated. Incorporate the latest target into the working/integration branch, repeat applicable checks and independent review, and rebind the final PR. This conservative gate prevents an automatic merge from introducing target content absent from the checked head.

A changed final revision invalidates obsolete check/review evidence while retaining its original revision and technical references. Re-run checks and independent review after fixes. Completion verifies the final PR actually merged into the repository's default target, its result is in that target's history, and each corresponding issue's current closure was caused by that PR. The parent and each delivered child are checked individually. The tracker does not close implementation issues, merge PRs or deploy. Keep issues open through ticket review/integration and use final PR closing references.

Before the human merge, put the final PR's closing references on their own lines (`Closes #SPEC`, then one `Closes #TICKET` per implementation issue). Read the PR's `body`, `baseRefName`, `headRefOid` and `closingIssuesReferences` through `gh pr view FINAL_PR --json body,baseRefName,headRefOid,closingIssuesReferences`; use paginated GraphQL when the complete reference set exceeds that command's result. Compare the planned references against the exact parent and every delivered child. Missing references remain an explicit handoff limitation; do not infer them from text alone. The repository's auto-close checkbox is not a required preflight observation when the API does not expose it, and must not trigger a Settings/browser request. Planned references establish intended closure only. After merge, the tracker still requires each issue's actual current PR-caused closure, the final PR's verified merge into the default target and its result in target history before completion. If GitHub leaves an issue open, final completion remains outstanding. Project Status still comes from verified tracker evidence; never manually close issues to manufacture PR-caused delivery.

The pinned REST2026-03-10 API [removed `merge_commit_sha` from PR payloads](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes?apiVersion=2026-03-10). Merged-result evidence uses GraphQL `mergeCommit.oid`, corroborated against the exact repository, PR identity, head, branch, target and merged timestamp.

Merge/squash/rebase may produce a different SHA. Checks and review transfer only when the actual merged result has the exact checked/reviewed tree; the evidence retains the original SHA and records the result it applies to. Different content needs renewed checks and combined review on the actual resulting SHA. Commit/history-sensitive checks still require explicit result-specific evidence. Mere ancestry cannot approve unreviewed output or detect reversals.

`reconcile` is a passive shared command, requiring no live controller. Trusted issue/PR/default-branch and scheduled wakeups use that same serialized fact-reading path, so a human merge can complete tracking after the originating conversation ends. Retries read current facts, including reopening, rather than publishing an old saved completion result. Transport/access failures remain unsynchronized. The activity observer evaluates freshness only; final reconciliation is separate.

## Cancellation, manual conflicts and reversed delivery

```sh
npm run agent:track -- cancel --issue ISSUE_OR_SPEC --reason 'Explicit decision and concrete reason' --result 'Implementation ended without delivery'
npm run agent:track -- reconcile
npm run agent:track -- reverse --issue ISSUE_OR_SPEC --delivery-pr ORIGINAL_PR --reversal-pr REVERSAL_PR --reason 'What delivered behavior is being undone' --evidence 'Concrete reversal review reference' --result 'Operator/reviewer attests this PR reverses the identified delivery'
```

Cancellation requires a reason, records Zrušeno/inactive and remains separate from successful delivery. A currently verified delivery refuses cancellation with `implementation_already_delivered` and preserves Hotovo/evidence. Reconcile stale facts first; reopening or a registered reversal are separate controls for invalidating delivered work. `stop`/agent interruption preserves the reached phase and evidence and makes activity inactive; it does not cancel tickets. Cancellation does not silently cancel other children or stop an owner: use explicit run controls and communicate the scope decision to workers.

Manual Project fields are display edits. The publisher reads back its last acknowledged projection, reports unsupported differences in the maintained comment, then restores evidence-backed values. Moving a card to Hotovo cannot satisfy the final gates or start/stop/take over agents. Enabled native Project workflows are rejected by doctor/worker; use the explicit setup option to remove competing closure-driven workflows.

Reopening invalidates an obsolete Hotovo claim and retains delivery history, returning only to a phase already supported by retained evidence with inactive activity. No implementer starts automatically. GitHub currently exposes no general queried PR-to-reversal relation. Register a reversal explicitly with its original delivery PR, distinct reversal PR, reason and actual operator/reviewer attestation. The tracker corroborates both PR identities, reversal merge and final-target history; it records which relationship is attested rather than claiming an automatic content proof. An unmerged registered reversal is pending, and passive reconciliation can invalidate the delivery after it merges. A delivered child can be named directly; its verified registered reversal invalidates both that child and the whole specification delivery. Partial reversals also invalidate the original complete-delivery claim. Missing/deleted Project membership is reported without inventing field values, then repaired through the existing idempotent membership path. Unreported manual reversals cannot be universally discovered from commit ancestry or guessed commit messages; report them through this control. Restoring implementation requires new applicable evidence, never silent agent launch or an arbitrary field move.

## First installation activation

Provisioning the Project/registry/Actions secret does not activate workflow code absent from the default branch. For this feature's initial installation, production tracking activates only after the maintainer merges the fully checked/reviewed integration PR. Do not merge partial implementation to bootstrap tracking itself or create another production writer. Exercise pre-installation lifecycle acceptance in the isolated acceptance repository with the complete tracker code on its default branch, and record the boundary truthfully. Once activated, standalone and multi-ticket sanctioned paths use the shared gated commands above.
