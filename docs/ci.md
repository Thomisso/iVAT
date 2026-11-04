# CI profiles and measurement

Both `CI` and `Deployment verification` run for every PR revision, ready/draft
transition, label change, and main push. They always report the existing stable
`check`, `e2e`, and `self-hosted` gates, including when runtime work is omitted.
A failed or cancelled prerequisite, an unexpected skip, or a failed classifier
fails its gate. No workflow-level path filter can leave a required check pending.

| Profile | Selection | Verification |
| --- | --- | --- |
| docs | Only root README/AGENTS/CODING_STANDARDS/GLOSSARY Markdown or Markdown under `docs/` | Policy tests and migration-history guard; no dependency install, database, browser, or containers |
| draft | Other changes on a draft PR | Policy, lockfile, migration history, typecheck and lint; no runtime stack |
| full | Ready PR, `ci:full` label, unavailable/empty diff, or any main push | All original release-policy, database-types, serial application tests, lint, types, production build, browser journeys and self-hosted deployment checks |

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

The `full` and `acceptance` jobs each run three shards on separate GitHub
runners. Vitest splits files with `--shard=N/3` and keeps `test:serial`;
Playwright splits files with the same flag and keeps one worker. Each shard
starts its own Supabase stack. No mutable database, production build or test
result is shared between runners. All files still run once; opt-in live-provider
contract tests remain opt-in.

Both matrices use `fail-fast: false`, so one failed shard does not cancel its
siblings or discard their diagnostics. The existing `check` and `e2e` gates
consume the aggregate matrix results and fail if any shard fails or is
cancelled. Browser trace artifacts include the shard number to avoid artifact
name collisions. Every shard retains its `always()` database cleanup. The docs,
draft, exact-main release evidence and PR cancellation policies are unchanged.

This trades additional runner setup for shorter elapsed time: dependency
installation, database startup and production build happen independently for
each shard. Do not interpret a shorter workflow as fewer runner minutes.

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
