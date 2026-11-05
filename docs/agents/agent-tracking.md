# Agent progress in GitHub

Use `npm run agent:track -- <command>` when reporting implementation work. The tracker separates reached implementation phase, verified agent activity and the latest result. The triage labels retain their existing issue-readiness meaning.

The first path supports an explicitly selected ticket. The #200 slices add automatic backlog membership, ticket review/integration, comprehensive recovery, independent freshness checks and final completion gates. Do not represent those later capabilities as already verified by this first slice.

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

The local journal also retains the last confirmed remote snapshot, including selected tickets and their published state. `show --local` reads this snapshot and pending intents without contacting GitHub; it does not claim the remote state is still current.

Starting a second controlling run is refused, including from another linked worktree. No heartbeat timeout releases ownership. Full explicit stop/resume/takeover is supplied by the recovery ticket, not by deleting a lock or changing a Project field. Keep review, integration, test-budget and eventual final-handoff rules in the existing implementation workflow.

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

`npm run test:agent-tracker` exercises the real commands in separate processes and isolated Git worktrees, controlling only the external `gh` boundary. `node scripts/verify-agent-tracker-transport.mjs` additionally drives real `gh` HTTPS through a stateful Postman GitHub simulation with a disposable synthetic token. The simulation exercises serialization, error mapping, partial effects, retries and original observation times; it does not prove actual Actions concurrency or upstream Projects permissions.

The registry uses a conservative 48 KiB application limit. Capacity failure refuses acknowledgment rather than truncating state. GitHub does not offer one atomic transaction covering Project fields, issue comments and the registry: partial publication remains unsynchronized and repairable. All supported writers use the same repository-wide Actions concurrency group with `cancel-in-progress: false`. External forced cancellation or ambiguous server-side execution must not be described as a universal atomicity guarantee.

Publish only technical progress and necessary repository references. Never pass credentials, sessions, private Documents or debug dumps as result text. Expected errors are structured JSON codes; raw provider error bodies are not emitted.
