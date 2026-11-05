# Agent progress in GitHub

Use `npm run agent:track -- <command>` when reporting implementation work. The tracker separates reached implementation phase, verified agent activity and the latest result. The triage labels retain their existing issue-readiness meaning.

The first path supports an explicitly selected ticket and durable run recovery. Other #200 slices add automatic backlog membership, review/integration, independent freshness checks and final completion gates; each requires its own acceptance evidence.

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

Starting a second controlling run is refused, including from another linked worktree. No heartbeat timeout releases ownership. Keep review, integration, test-budget and eventual final-handoff rules in the existing implementation workflow.

## Stop, resume and explicit recovery

After stopping the run's workers through the orchestration tools, release its ownership explicitly:

```sh
npm run agent:track -- stop --reason 'Controller work stopped'
npm run agent:track -- resume --run qa-200-controller
```

Stopping records a validated ended-owner history and leaves reached phases and review/integration evidence intact. Its tickets become inactive. Resuming a stopped run acquires a new generation; it does not silently restart its former workers. Deliberately claim a historical inactive ticket again with the intended agent and real local branch to transfer it to the new owner. Its reached phase and prior review/integration evidence remain associated with their original revisions; worker activity becomes unverified until genuinely observed.

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

Local process locks are shared by linked worktrees. A lock is reclaimed only when its recorded local PID is demonstrably gone, under a separate reclaimer election; a live, foreign-host, partial or otherwise unverified owner remains refused. There is no age-based lock removal. Killing the controller and removing its disposable worktree leaves the durable outbox in the Git common directory for recovery.

## Verification

`npm run test:agent-tracker` exercises the real commands in separate processes and isolated Git worktrees, controlling only the external `gh` boundary. `node scripts/verify-agent-tracker-transport.mjs` additionally drives real `gh` HTTPS through a stateful Postman GitHub simulation with a disposable synthetic token. The simulation exercises serialization, error mapping, partial effects, retries and original observation times; it does not prove actual Actions concurrency or upstream Projects permissions.

The registry retains a ring of 32 terminal manual receipts, plus the current owner's latest ordered outcome (or the latest explicit stop), and all pending outcomes. Automatic discovery has its separate bounded published-receipt window. FIFO clients durably consume an acknowledgment before sending the next owned sequence; passive retries whose old receipt was pruned recompute current facts instead of replaying an old snapshot. An unknown old owned acknowledgment is never treated as success or reinterpreted as a new phase event.

The registry uses a conservative 48 KiB application limit. Pending intents, controlling history and active evidence are not silently truncated when it fills; capacity failure refuses acknowledgment. GitHub does not offer one atomic transaction covering Project fields, issue comments and the registry: partial publication remains unsynchronized and repairable. All supported writers use the same repository-wide Actions concurrency group with `cancel-in-progress: false`. External forced cancellation or ambiguous server-side execution must not be described as a universal atomicity guarantee.

Publish only technical progress and necessary repository references. Never pass credentials, sessions, private Documents or debug dumps as result text. Expected errors are structured JSON codes; raw provider error bodies are not emitted.
