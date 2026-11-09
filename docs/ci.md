# CI profiles and measurement

Both `CI` and `Deployment verification` run for every PR revision, ready/draft
transition, label change, and main push. They always report the existing stable
`check`, `e2e`, and `self-hosted` gates, including when runtime work is omitted.
A failed or cancelled prerequisite, an unexpected skip, or a failed classifier
fails its gate. No workflow-level path filter can leave a required check pending.

| Profile | Selection | Verification |
| --- | --- | --- |
| docs | Only root README/AGENTS/CODING_STANDARDS/GLOSSARY Markdown or Markdown under `docs/` | Policy tests, migration-history guard and tracker command behavior; no dependency install, database, browser, or containers |
| draft | Other changes on a draft PR | Policy, tracker command behavior, lockfile, migration history, typecheck and lint; no runtime stack |
| full | Ready PR, `ci:full` label, unavailable/empty diff, or any main push | Release-policy, database-types, all three serial application-test shards, lint, types, production build, CLI production HTTP acceptance and self-hosted deployment checks |

`ci:full` explicitly requests complete verification while an integration PR stays
draft. Removing it returns a draft to its cheap profile. Publishing a PR as ready
and every later commit trigger complete checks automatically. Runtime assets,
dependencies, migrations, workflow changes, design assets, and unknown paths are
never classified as documentation. The classifier reads the complete Git merge
base diff, without a changed-file API page limit.

PR concurrency groups contain both workflow name and PR number: a newer run
cancels obsolete work for the same PR only. Main runs each have their own group,
so the exact commit needed for release evidence remains verifiable. The separate
production deploy concurrency group remains non-cancelling. Disposable Supabase
and Compose stacks have `always()` cleanup steps. Cancellation never targets a
human's stack.

Release policy is unchanged: successful **main-push** runs of both workflows for
the exact release revision are required. A docs/draft PR run, cancelled run,
skipped runtime job, or successful different revision cannot supply that evidence.
Main always uses the full profile. No scheduled workflow was introduced.

## Scheduling and shared execution owners

The fast `profile` job runs policy tests, classifies the complete change and
checks migration history. After it succeeds, tracker command behavior, common
checks, all three application shards and production HTTP acceptance can start
independently. Application jobs never wait for tracker completion or the common
checks. The current docs/draft/full selection remains unchanged; tracker command
behavior still runs for every profile at this foundational stage. Later
change-aware infrastructure selection is separate work under #254.

For draft/full verification, `common` owns lockfile consistency, typecheck and
lint once. Full verification additionally runs the complete release-policy,
bundle/transport/host suite and real-gh tracker transport once in that job.
Database-type verification runs only on application shard 1, using its existing
isolated stack. All three shards retain their complete serial application-test
inventory and unconditional cleanup; no extra database stack is introduced.

The production HTTP runner owns the single plain application build. The former
plain build in each application shard is removed because the HTTP runner builds
and runs that same application revision in production mode. Deployment
verification still builds and exercises the actual production Docker images as
distinct packaging evidence. No passing build artifact is transferred between
jobs and no earlier revision's build result is reused.

`check` requires the profile, tracker command suite, common checks and all
application shards. `e2e` requires the profile, common checks and HTTP acceptance.
Both gates run after any prerequisite outcome and reject failed, cancelled,
missing or unexpectedly skipped selected work. Common checks are explicitly
skipped only for docs; application/runtime work is skipped only for docs/draft.
The separate `self-hosted` gate keeps its production-runtime prerequisites.

This graph adds a tracker job's checkout/Node setup and, on full runs, one
common job's checkout/Node setup/dependency install. Full CI now has five
`npm ci` owners (common, three shards, HTTP), compared with four before; common
checks no longer execute three times and the four plain application builds
become one. The real Actions run must measure this replacement setup overhead,
actual suite start/overlap, shared-check/build counts, queue time and summed
runner time before any elapsed-time or cost saving is claimed. Local policy
checks establish the configured execution contract, not measured concurrency.

## Fixture costs

Scalar JSON inventory queries now demonstrate completeness with 21 real rows
and an actual temporary PostgREST response cap of 20. A direct query proves the
cap is active before the application query runs; the fixture restores the prior
configuration, waits until restoration is observable, and closes its connection
in `finally`. This is confined to serial tests in an isolated stack, and is never
used around pagination code assuming a 1,000-row page. Membership tests retain
real Auth identities and RLS; their inventory falls from 1,000 Auth Users to 21,
with identity/Organization cleanup. Platform completeness inventory falls from
1,001 Companies/Organizations to 21, also with cleanup.

Storage authorization checks use 31 unrelated Companies rather than 1,001. Their
security property depends on the first folder, identity, and preserved bytes,
not on crossing a PostgREST response page. They still call actual Storage under
owner/outsider identities. This is not a product Company limit or a load test.

Document/report/lock tests retain 1,001 Documents where the real 1,000-row boundary
matters. Large report setup invokes the same worker reservation and recording
functions in a single PostgreSQL transaction instead of making 2,002 HTTP calls;
real user queries, approval, report generation and Finalization remain unchanged.
No database files run concurrently over a shared mutable stack.

## Isolated test shards

The `full` job runs three independent financial/application shards on separate
GitHub runners. Vitest splits files with `--shard=N/3` and keeps `test:serial`.
Each shard owns its Supabase stack. `fail-fast: false` retains sibling results
and diagnostics if one fails. All application files still run once; live-provider
contract tests remain opt-in.

### Measured application allocation

`vitest.config.ts` configures Vitest's public `BaseSequencer` extension in
`scripts/application-test-sequencer.ts`. `--shard=N/3` distributes the current
Vitest-discovered inventory by longest measured file first, assigning each file
to the lightest shard. Relative paths break equal-duration ties; the lowest
shard index breaks equal-load ties. Discovery order and absolute checkout paths
do not affect the result. The timing file is a weight source, never an inclusion
list: new, renamed and unmeasured files receive the recorded median duration
(currently 5,500 ms) and remain selected exactly once. Unsharded commands still
select the complete inventory. File execution stays serial, with the same three
isolated stacks and unconditional teardown.

The versioned `scripts/application-test-timings.json` records 111 emitted file
durations from successful [CI run 42476395666, attempt 2](https://github.com/Thomisso/iVAT/actions/runs/42476395666/attempts/2),
revision `7997422a307cda3bbcc66e39030810b637c4aa65`, on `ubuntu-latest`.
The complete current inventory contains 117 files. Five live-provider contract
files and the opt-in OpenAI simulation file did not emit timings in that run;
they retain their existing opt-in skip behavior and receive the fallback weight.
No application tests, assertions or large-data scenarios were removed.

| Allocation | Shard 1 | Shard 2 | Shard 3 |
| --- | ---: | ---: | ---: |
| Recorded file-duration sums | 172.360 s | 409.877 s | 199.395 s |
| Weighted projection for the same 111 measured files | 260.545 s | 260.545 s | 260.542 s |
| Weighted projection including six fallback weights | 271.545 s | 271.545 s | 271.542 s |

These are sums of file durations, not application-step wall time or billed
runner time. The projections do not establish a measured critical-path saving;
checkout, dependency install, Supabase startup, file import/worker overhead,
cleanup and per-job rounding still require the bounded real full CI comparison.
No additional stack or dependency install is introduced by allocation. The
common job runs `node --test scripts/tests/application-shards.test.mjs` once
after its existing install. It checks an actual small serial runner fixture,
complete non-overlapping discovered selection, discovery-order independence,
and new/renamed path fallback without starting application databases.

When refreshing weights, retain the actual successful run, attempt, revision,
runner and source job for each measured file. Keep skipped/unmeasured files in
the discovered inventory rather than inventing zero durations or deleting them.
Re-run the focused allocation check and update the comparison against the same
inputs; reuse an applicable full verification instead of launching repeated
full suites solely to benchmark allocation.

The single `acceptance` job runs `npm run test:http`: one real production build,
Next server, worker and isolated stack for the complete HTTP suite. It uses real
Auth, native SSR cookies, public application commands/RLS and HTTP routes; the
existing Postman ARES and local fake-provider seams keep external calls local.
A loopback control around the existing real-Supabase gateway exercises private
transport, bounded dependency failure, independent liveness and recovery.
The suite also verifies anonymous/member/foreign authority, localized SSR,
original/recorded bytes, immutable XML artifacts and stable download headers.
It does not assert hydration, keyboard/focus, responsive layout or visual results.

The existing `check` and `e2e` gates consume actual prerequisite results and
fail if their required jobs fail, cancel or unexpectedly skip. HTTP service logs
are retained as `http-acceptance-logs` on failure. Every owned runtime retains
its `always()` database cleanup, and the local runner also tears down its stack.
The docs, draft, exact-main release evidence and PR cancellation policies remain.
No default package command or CI job installs or launches a browser. Retained
Playwright sources are historical inventory under [the execution policy](agents/cli-processes.md).

The following timing records describe the earlier browser-based workflow and
remain historical evidence; they are not instructions to execute it again.

### Failure at `21b66bb`

[Main CI 41686777759](https://github.com/Thomisso/iVAT/actions/runs/41686777759)
took 26:06 from creation to the last required gate. Its application test step
took 1,256.95 seconds; one of 1,028 tests failed. The browser suite ran 93 tests
with one worker and reported 87 passed, one failed and five skipped in 18.7
minutes. Database startup took 98.4 seconds and its production build 57.9
seconds. The preceding application revision passed in
[CI 41685633691](https://github.com/Thomisso/iVAT/actions/runs/41685633691), with
a 981-second application test step. `21b66bb` itself changed documentation only.

The browser trace showed two injected 503 upload responses, followed by a real
500 and a successful retry. The Next.js log identified PostgreSQL deadlock
`40P01`. Source File insertion locked Upload Batch before Company, while the
processing worker locked Company before Upload Batch. Migration
`20261128090000_upload_company_before_batch.sql` puts the upload on the same
lock order. `tests/source-upload-concurrency.test.ts` coordinates a real upload
with the worker's database transition: it reproduced `40P01` before the fix in
1.74 seconds and passed after it. The browser's exact transfer-count assertion
is retained.

The Security return test bundled twelve database-backed resolutions into one
20-second test. Its entire nine-test file passed in 2.56 seconds on a clean
local stack, compared with 60.67 seconds and one timeout in the failed CI run.
The read-only fallback cases now share fixture setup but have separate verdicts
and timeout budgets. This preserves every assertion without raising the global
timeout. Sharding also limits unrelated fixture accumulation on each stack;
these observations do not establish a production query performance fix.

The first sharded trial,
[PR CI 41794647749](https://github.com/Thomisso/iVAT/actions/runs/41794647749),
completed in 678 seconds including its two-second initial queue. All three
browser shards and two application shards passed; the remaining application
shard exposed a statement timeout during setup of the 1,001-Document lock test.
Its setup loaded the full workspace reporting projection just to obtain IDs.
The large fixture now returns the IDs produced by its existing worker recording
transaction. The test still queries every lock under the User's identity,
checks all 1,001 results and verifies approval refusals and the saved snapshot.
With the isolated database restricted to 0.15 CPU, the original setup reproduced
the statement timeout in 16.72 seconds; the revised test passed in 20.38 seconds
under the same restriction without changing any timeout or reducing the data.
The CPU restriction was removed after the experiment. This is fixture isolation,
not an optimization of the full workspace projection; that query can still
require separate performance work for large Companies.

### Supabase startup port collision

The ready-for-review rerun at the same `d42218d` revision,
[CI 41807140100](https://github.com/Thomisso/iVAT/actions/runs/41807140100),
passed both other application shards, all browser shards and the separate
Deployment verification. `full (1)` failed before any application test ran:
Docker could not publish Mailpit on host port `54324` (`address already in use`).
The failed run did not capture the owning socket, so its process cannot be
identified retrospectively.

Supabase's `54320–54329` host ports overlap Linux's default automatic port range.
Every Supabase CI shard now adds that range to
`net.ipv4.ip_local_reserved_ports` before checkout, downloads or test listeners,
preserving any reservations already present on the disposable runner. The
[kernel documentation](https://docs.kernel.org/networking/ip-sysctl.html#ip-variables)
explains that reserved ports are excluded from automatic allocation while
explicit service binds still work. This prevents ephemeral connections and
`listen(0)` helpers from taking the fixed Supabase ports; it does not evict an
explicit listener. A failed startup also captures sockets and container port
bindings before the workflow cleanup.

A deterministic reproduction in a separate Docker network namespace exhausted
an automatic range containing `54324`, then asserted that an explicit Mailpit
bind could succeed. It failed with `EADDRINUSE` without a reservation and passed
with `54320–54329` reserved, including with an additional pre-existing reserved
port. No host kernel setting or human development stack was changed locally.
CI policy tests check that all configured Supabase host ports are covered and
that reservation precedes network setup. A reservation is a startup safeguard,
not a test retry or a relaxed check.

The three-way split is an elapsed-time optimization, with a provisional target
of roughly 10–12 minutes based on the observed test time plus independent setup.
File durations and runner contention can make shards uneven. The new workflow
must be measured on GitHub before claiming that target as an achieved result.

The existing npm download cache remains enabled. Cache misses still install from
the lockfile. No binary/test-result reuse, Docker cache, browser cache, or Next.js
artifact reuse is claimed: baseline measurements do not establish enough benefit
to justify changing build provenance or sharing environment-specific artifacts.

## Reproduction and evidence

Local commands:

```bash
node --test scripts/tests/ci-policy.test.mjs
node --test --test-name-pattern='workflow evidence|exact|main' deploy/tests/release-prepare.test.mjs
npm run db:start
npx vitest run tests/memberships.test.ts tests/platform-administration.test.ts tests/superadmin-tenant-access.test.ts tests/storage-listing.test.ts tests/period-lock.test.ts tests/vat-reports.test.ts tests/reporting-period-readiness.test.ts
npm run test:serial
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Run the full serial suite once after ticket integration, not concurrently in
every ticket worktree. Read-only timing extraction records revision, runner
labels, conclusion, queue estimate, wall time, summed job time and step times:

```bash
node scripts/ci-timings.mjs 41110237322 41110237242 41106273866
```

The queue estimate is workflow creation to first job start; scheduling delays
between dependent jobs are included in workflow wall time. Summed job intervals
are runner seconds, not developer waiting time or billable rounded minutes.
Record cache hit/miss from job logs separately; elapsed timings cannot establish
cache state. Compare like runner classes and record revision and application
changes. Treat cancelled/failed runs separately from successful full verification.

Baseline on revision `58048c1cfd14e30c0c188a81782eb8e3b53c1f78`:

| Successful run | Workflow wall observation | Jobs/steps |
| --- | --- | --- |
| [Main CI 41110237322](https://github.com/Thomisso/iVAT/actions/runs/41110237322) | Created to updated 17:02; first job starts after 3 seconds | check 16:54, E2E 10:33; test step 12:49 |
| [Same-revision deployment 41110237242](https://github.com/Thomisso/iVAT/actions/runs/41110237242) | Extract independently with timing command | self-hosted 4:41 |
| [Earlier PR CI 41106273866](https://github.com/Thomisso/iVAT/actions/runs/41106273866) | Different revision; contextual baseline only | check 10:15, E2E 12:17; test step 6:45 |

The main three-job sum was 32:08. CI used `ubuntu-latest`, Node 22 and the existing
npm cache; cache warmth is not established by these summaries. The 12:48.7 test
run was spread across suites: Memberships 58.4s, Period Locks 50.8s, Companies
45.8s, EPO export 31.5s, VAT reports 28.9s, duplicate warnings 27.4s, tenant
isolation 27.1s, audit 23.7s, readiness 22.2s and platform access 22.0s. Membership
inventory alone is not the explanation for the total. E2E spent 116.1s starting
its database, 43.8s building, and 408.3s running the browser suite. Installation
was 16s, Postman 8s, Chromium 19s. Three stacks are deliberate independent
boundaries, not permission to share mutable databases.

The latest-50 historical sample spans 2026-10-29 20:36 UTC to 2026-10-30
19:21 UTC: 34 PR CI runs (17 success, 10 failure, 6 cancelled, 1 startup failure),
6 main CI runs (5 success, 1 failure), 7 PR deployment runs (5 success, 1 failure,
1 cancelled), 2 successful main deployment runs and 1 successful release run.
This is a bounded sample, not a claim about all project history. Cancelled and
failed attempts are not folded into the successful baseline above.

Before these changes both test workflows ran heavy stacks for
every PR/main trigger, without obsolete-PR cancellation; docs/draft profiles now
omit those stacks. The completed #181 comparison used successful baseline CI
[41110237322](https://github.com/Thomisso/iVAT/actions/runs/41110237322) and
deployment [41110237242](https://github.com/Thomisso/iVAT/actions/runs/41110237242)
at `58048c1cfd14e30c0c188a81782eb8e3b53c1f78`, versus full opted-in draft PR CI
[41134309954](https://github.com/Thomisso/iVAT/actions/runs/41134309954) and
deployment [41134309990](https://github.com/Thomisso/iVAT/actions/runs/41134309990)
at `c6b1345855b792cf1213a331efc377b34eed02c0`. All stable gates and cleanup passed.

| Measurement | Before | After |
| --- | ---: | ---: |
| CI workflow wall | 1,014 s | 670 s |
| CI summed runner time | 1,647 s | 1,313 s |
| Deployment workflow wall | 281 s | 293 s |
| Deployment summed runner time | 281 s | 289 s |
| Combined runner time, including profile/gate jobs | 1,928 s | 1,602 s |

Both workflows had three-second initial queues. Heavy jobs used the same Ubuntu
26.04 image `20261025.179.1`, runner `2.338.2` and npm primary-cache hit; one
12-second final gate used an older Ubuntu 26 image and is included in the total.
The event differs (main push versus full opted-in draft PR), while application
behavior and lockfile matched. This is a representative observation, not a
performance guarantee. The serial test step fell from 768.70 to 377.47 seconds;
browser execution remained 408.3 versus 409.0 seconds. Deployment alone became
12 seconds slower; its added overhead is included rather than omitted.

An independent same-PR replacement cancelled obsolete CI
[41134349157](https://github.com/Thomisso/iVAT/actions/runs/41134349157) and
deployment [41134349223](https://github.com/Thomisso/iVAT/actions/runs/41134349223),
while the separate integration PR's full runs continued. Heavy jobs were
cancelled, stable gates refused incomplete verification, and the database and
runtime cleanup steps succeeded. Replacement docs CI
[41134425777](https://github.com/Thomisso/iVAT/actions/runs/41134425777) skipped
heavy jobs and passed both gates. These observed cancellations and cleanups are
separate from the successful full-run timing comparison. Local timings and
draft checks do not replace exact-main CI or release gates.
