# iVAT

iVAT turns financial documents uploaded by Czech VAT payers into validated, structured data and produces the Czech VAT Return and Control Statement for a Reporting Period. Domain terms are defined in [`GLOSSARY.md`](GLOSSARY.md), and architectural decisions are recorded in [`docs/adr/`](docs/adr/).

## Stack

- **Next.js** (App Router, TypeScript) serves the UI and server actions.
- **Worker** (`worker/`): a separate Node process that runs background jobs on **pg-boss**.
- **Supabase**: Postgres with Row-Level Security, and Auth. Locally, everything runs through the Supabase CLI ([ADR-0002](docs/adr/0002-typescript-supabase-stack-local-first.md)).
- **next-intl** handles i18n in Czech (default) and English. The language is a per-browser cookie.

Production records, credentials, backup archives and account-specific design
references stay outside Git. See [repository publication](docs/publication.md)
for the cleanup and history-cutover requirements.

## Operational email alerts

MFA-verified SuperAdmins can opt in under Platform Settings. Delivery uses their
current verified Auth email, with the language captured from the application's
current CS/EN language when saving the preference. Preferences are off by default.
An address undergoing an unverified change is ineligible until verified.

The existing `npm run worker` process reconciles critical work every 30 seconds
without an open platform page. Configure canonical `APP_ORIGIN` and the same
managed `SMTP_*` transport used for Invitations; production requires authenticated
TLS. Explicit `SMTP_LOCAL_CAPTURE=true` is restricted to loopback capture. Never
use production SMTP for tests. A missing or invalid canonical origin prevents
dispatch. The five-minute grace period begins with the first authoritative worker
observation, so restarting after an unobserved outage does not backdate eligibility.

Private episodes preserve root identity across impact-count changes. The first
slice attempts each eligible recipient once; accepted, refused, definite failure
and unknown are distinct durable outcomes. A crash after claim or an uncertain
SMTP response is not automatically retried. Acceptance means the SMTP server
accepted the message, without an Inbox or exactly-once guarantee. No reminders or
recovery messages are sent by this first slice (#321); #322 owns that later policy.
The active dashboard and existing audit/remediation flows remain the authorities.

## Prerequisites

- Node.js 22+
- Docker, which the local Supabase stack runs in

## Getting started

```bash
npm install
npm run db:start             # start local Supabase (applies migrations) and write .env.local
npm run dev                  # app on http://localhost:3000
npm run worker               # background worker, in a second terminal
```

Open http://localhost:3000/login. Public registration is closed. MFA-verified SuperAdmins can create an empty
Organization in platform administration, then add Companies or invite its first
Administrator through the existing membership management. For a fresh local QA account,
run `npm run dev:seed`; it privately provisions the User, signs in through Auth,
and prints sign-in details. Local SuperAdmin bootstrap and administrator-issued
Invitations remain the supported provisioning paths. Signed-in Administrators
can still create and manage Companies. Supabase Studio runs at
http://127.0.0.1:54323.

Email/password sign-in works without third-party credentials. To enable Google
sign-in locally, follow [`docs/google-sign-in.md`](docs/google-sign-in.md).

New Companies receive the platform's default AI Configuration and a lifetime allowance of 50 successful Extractions. A SuperAdmin can change assignments, access and allowances; Company users only see their allowance and waiting-Document status. Locally, `AI_PROVIDER=fake` (the default written by `db:start`) Splits every page into its own Document and returns a sample Extraction, so no Document leaves your machine. Set `AI_PROVIDER=platform` for per-Company Anthropic/OpenAI routing through SuperAdmin-owned configurations.

VAT registry and exchange-rate adapters are selected independently. Ordinary operation uses ADIS and ČNB. For fully deterministic local/demo processing, set `VAT_REGISTRY_PROVIDER=fake` and `EXCHANGE_RATE_PROVIDER=fake` in `.env.local`; fake AI alone does not select them. The E2E runner sets all three fake modes explicitly and reuses the existing registry/rate adapters.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run db:start` / `db:stop` | Start or stop the local Supabase stack; `db:start` also writes its URL and keys to `.env.local` |
| `npm run db:migrate` | Apply new migrations to the local database, keeping its data. A migration already applied is not re-run: after editing one, use `db:reset` |
| `npm run db:reset` | Recreate the local database from `supabase/migrations/` (deletes all local data) |
| `npm run db:types` | Regenerate `src/lib/database.types.ts` from the local schema after a migration |
| `npm run dev` | Next.js dev server |
| `npm run worker` | Worker process (restarts on change) |
| `npm run dev:seed` | Create a fresh QA account with a Company and an uploaded Source File; prints its sign-in details |
| `npm run bootstrap:superadmin -- --email <email>` | Create or reuse one local Auth User and grant SuperAdmin; a password is generated for a new User unless `--password-stdin` is used |
| `npm run demo` | Start Supabase and apply new migrations, start the dev server on a free port and the worker, seed a demo account, and print the URL, login and password. Ctrl+C stops the servers |
| `npm run typecheck` | Generate Next route types, then run `tsc` |
| `npm run lint` | ESLint |
| `npm test` | Application-layer tests; requires `npm run db:start` |
| `npm run test:serial` | The full application-layer suite with one Vitest worker; use for the final integration check |
| `npm run evaluate:extraction` | Run the manual real-provider golden-set accuracy harness (not CI) |
| `npm run build` | Production build |

## Layout

```
src/application/   commands and queries; each takes a Supabase client acting as a user (AppClient),
                   plus the background job handlers (processing.ts) and the AI provider interface
src/ai/            fake, Anthropic and OpenAI adapters and selection by AI_PROVIDER
src/app/           Next.js routes and server actions, thin wrappers over src/application
src/i18n/          locale config; messages are in messages/{cs,en}.json
src/proxy.ts       session refresh and login redirect
supabase/          CLI config and SQL migrations (schema, RLS policies, audit triggers)
worker/            background job runner
tests/             application-layer tests against the local database
```

## Resetting the local database

With the local Supabase stack running, reset the entire local database with:

```bash
npm run db:reset
```

**This deletes all local database data and reapplies the migrations.** If the
stack is stopped, run `npm run db:start` first. To apply new migrations while
keeping existing data, use `npm run db:migrate` instead.

After a reset, recreate the SuperAdmin:

```bash
npm run bootstrap:superadmin -- --email operator@example.test
```

Sign in and enroll TOTP again. Recreate the Companies you need and, for real AI
processing, recreate the AI Configuration at `/platform/ai-settings` with the
provider API key and Split and Extraction models. Assign it to the Company and
ensure AI access is enabled with remaining processing allowance. The reset
leaves `.env.local` unchanged; keep `AI_PROVIDER=platform` for real providers.

## Local SuperAdmin bootstrap

`npm run db:reset` applies an intentionally empty seed: it does not preserve or
create a QA dataset, Auth User or SuperAdmin. Create the platform operator only
when needed:

```bash
npm run bootstrap:superadmin -- --email operator@example.test
```

For a new Auth User, the command prints a generated password once. To supply a
password without putting it in the process arguments, pipe it on standard input
and add `--password-stdin`. To promote an existing identity without creating
one, use `--user-id <auth-user-uuid>`; a missing UUID is rejected. Repeating the
command is safe and leaves exactly one SuperAdmin record.

New operators are created through native Auth with a service-only, short-lived
reserved User id. This skips automatic Organization/Membership provisioning;
the reservation grants no Role itself and is released after Auth creation.
Retired ids remain without email so delayed requests fail closed rather than
falling back to automatic tenant provisioning.
Promoting an existing User preserves their historical Memberships and credentials.
Active user lists and counts omit platform SuperAdmins without deleting those
Memberships. Platform access still requires the operator's own MFA session.

The command accepts only a localhost Supabase URL and reads the secret key from
the gitignored `.env.local` written by `db:start`; it never prints that key.
MFA is not seeded. After signing in, the SuperAdmin follows the normal product
flow to enroll TOTP. QA/demo data remains a separate, explicit `dev:seed` step.

## Tenancy, security and audit

- Organization → Company → Membership ([ADR-0001](docs/adr/0001-organization-tenant-with-shared-postgres-rls.md)). Every tenant-owned table carries `organization_id` (and `company_id` where applicable). RLS policies derive access from the user's Memberships. An Organization Administrator can access all of the Organization's Companies.
- Sign-up is handled in the database: a trigger on `auth.users` creates the Organization and the Administrator Membership in the same transaction.
- `audit_event` is append-only. Only database code writes to it (`private.record_audit_event`, called from triggers). Users can only read it, and only as an Organization Administrator. Update, delete and truncate are rejected for every role.

## Processing

Uploading a Source File enqueues a Split job (pg-boss). The worker Splits the file into Documents through the AI provider, then runs one Extract job per Document. Each Extract job stores an immutable Extraction Version and moves the Document to NeedsReview ([ADR-0004](docs/adr/0004-split-then-extract-with-multimodal-llms.md), [ADR-0005](docs/adr/0005-immutable-extraction-versions.md)).

- Statuses: a Source File is `uploaded → processing → split`, and each Document is `uploaded → processing → needs_review`. Either ends in `failed` once a technical error has used up its retries. A failed Split can be retried. A failed or reviewed Document can be reprocessed, which adds a new Extraction Version.
- No job calls a real AI provider unless the Company has an enabled assignment to a usable platform-owned AI Configuration and remaining allowance ([ADR-0011](docs/adr/0011-platform-owns-ai-credentials-and-company-access.md)). Assignment, access and allowance changes are audited.
- The worker acts as `service_role`, but only through narrow grants and the `record_split` / `record_ai_extraction` functions, which keep jobs idempotent ([ADR-0010](docs/adr/0010-worker-acts-as-service-role-through-narrow-grants.md)).
- The Extraction payload schema is documented in [`docs/extraction-payload.md`](docs/extraction-payload.md).

## Git worktrees

For the internet-facing pilot on Roští, see [deployment and recovery](docs/deployment.md)
and the [private deployment record notice](docs/deployments/2026-10-30-rosti-pilot.md).
It runs the application and self-hosted Supabase in one Stack, independently of
the local Supabase CLI environment.

Git worktrees are separate working directories of the same repository: they share history and branches, while each has its own checked-out files and uncommitted changes. iVAT requires one branch and worktree per implementation ticket to isolate simultaneous human and agent work. Sibling directories such as `../iVAT-253` are the project convention, not a Git requirement. Changes in a ticket worktree appear in the main checkout only when its checked-out revision incorporates them.

Database scripts share checkout selection through `localSupabaseContext()` in `scripts/supabase-status.mjs`. Public CLI operations go through `scripts/supabase.mjs`; `db:types` captures generated source privately for its intended file instead. In the main checkout they use `supabase/config.toml` as is. A linked git worktree gets its own stack instead: a separate database, ports shifted by 100 × a slot derived from the worktree path, and no Studio, Mailpit, analytics or edge runtime. Parallel worktrees can reset and test their databases independently. If two worktrees land on the same slot, set `SUPABASE_SLOT` (1–99) for one of them. This database isolation comes from the project scripts, not Git itself.

Supabase wrapper output is redacted on both stdout and stderr, including failed
commands. Service URLs and process results remain available; credential values
are replaced with `[REDACTED]`. Oversized output lines are omitted rather than
partially exposing credentials. This also applies to `status -o json`: use
`scripts/supabase-status.mjs`'s `readSupabaseStatus()` inside trusted local tooling
when it needs actual credentials. It captures status privately with safe errors;
there is no public raw-output option. `db:types` uses the same private checkout
context to write unredacted schema text to `src/lib/database.types.ts`, preserving
fields such as `api_key` while keeping stdout private and stderr redacted even
on failure. Startup still writes the actual values to the owning checkout's
ignored `.env.local`.

### Worktree lifecycle

1. **Create or resume.** Inspect `git worktree list` and the intended worktree's status before reusing it. For a new ticket, create a branch from its intended target (the integration tip for a child ticket), for example `git worktree add ../iVAT-253 -b fix/pdf-boxes-253 <base>`. Run `npm ci` there; start its Supabase stack with `npm run db:start` when the work needs a database. Preserve existing changes and keep the human's checkout and services untouched.
2. **Identify the environment.** Tell the user the ticket, worktree path, branch and service state at the start or resumption of implementation. Mark the local URL pending until a server is ready, or state that no server is needed for this task. Once started, report the actual URL from the server banner and update it if it changes. Keep machine-local paths, localhost URLs and credentials out of shared GitHub tracking evidence.
3. **Run and verify.** Use a free application port, for example `npm run dev -- -p 3100`, and a worker when needed. Install dependencies per worktree and keep its build output, configuration and database separate. Run the checks required by the implementation workflow; worktree isolation does not replace verification. Start only the stacks needed for current work, and follow the [shared test budget](docs/agents/implementation-workflow.md#test-budget) to limit Docker contention.
4. **Hand off or pause.** Stop the servers, workers and database stack started for this task once they are no longer needed. Keep services the user asked to retain running. Use `npm run db:stop` from the owning worktree when its data must be retained. Preserve the worktree and branch while review, fixes or resumption need them. Report the checked revision, check results, whether its URL is still running and any retained environment with its reason.
5. **Remove after delivery.** Once delivery is verified and the worktree is no longer needed, confirm that its tracked and untracked files and local-only commits contain no work to preserve. Stop its owned servers and workers, then run `npm run db:stop -- --no-backup` from that worktree to discard its disposable stack data. From another worktree, use `git worktree remove <path>` without force. If work, data or another active user still needs the environment, retain it and report why. Preserve the shared tracker journal in the Git common directory for recovery.

## Agent verification

Agent processes follow the [CLI-only execution policy](AGENTS.md#agent-execution) and [evidence rules](docs/agents/cli-processes.md). Use the project [run-app](.claude/skills/run-app/SKILL.md) and [next-dev-loop](.agents/skills/next-dev-loop/SKILL.md) skills for isolated CLI/HTTP runtime checks and real-user application checks. Record unverified client or visual behavior explicitly; a successful page response does not establish it.

## Testing

PDF Extraction requires Poppler (`pdftoppm`) on the worker and test host. Install
`poppler` with Homebrew on macOS or `poppler-utils` with apt on Debian/Ubuntu.
The production Docker image and CI application/HTTP runners install it explicitly.

Tests exercise the application layer as real users against the local Postgres with RLS enabled, per the seams in the requirements' Testing Decisions. Background jobs run synchronously through the worker's own handler (`testWorker` in `tests/support/worker.ts`), against a scripted fake AI provider. Tests create their own users and Organizations, so they need no reset between runs:

```bash
npm run db:start
npm test
```

Integration and HTTP acceptance fixtures provision accounts through the isolated
Auth admin API, then sign in through real Auth. Privileged setup stays in the
Node test process; session cookies use the native Supabase SSR serializer and
never appear in reports. No public provisioning endpoint is added.

The production acceptance command owns this worktree's disposable Supabase
stack: it stops it without retaining data, starts Auth/Storage/Mailpit and the
real worker, builds and starts Next.js, then runs the HTTP suite:

```bash
npm run test:http
```

Run it from a linked worktree; it refuses the human main checkout before any
database command. CI uses disposable runners. `IVAT_HTTP_BASE_URL` may select an
unused `http://127.0.0.1:PORT`; otherwise the runner allocates a free port. A
busy port fails before the database reset. Normal completion and startup
failure stop the owned services and database. Failures retain service logs in
`test-results/service-logs/`.

`npm run test:e2e` is an alias for the same HTTP runner. For a focused loop
without the production build, use `npm run test:http:dev` (`test:e2e:dev` is
its alias). Final acceptance uses the production command. No browser binary
installation or browser process is part of either path.

The suite checks localized SSR, anonymous/member/foreign-tenant authority,
upload HTTP requests and durable worker completion, current/recorded Document
responses, original/page bytes and headers, draft/final immutable XML artifacts,
and real private Auth transport with failure/recovery. Its ARES dependency is
the existing local Postman simulation; AI, VAT registry and exchange rates use
the established fake adapters. It does not call real external providers.
It proves HTTP/application outcomes, not hydration, focus, keyboard behavior,
responsive layout, accessibility or visual rendering. Those client-specific
claims remain unverified. Retained `e2e/` Playwright files are historical/source
inventory and are not an executable verification path under the project policy.

The real-provider extraction evaluation is a separate manual command. Its
versioned golden-set format, credentials, model overrides, scoring rules, and
illustrative fixtures are documented in
[`evaluation/golden-set/README.md`](evaluation/golden-set/README.md).

## CI

`.github/workflows/ci.yml` and deployment verification use docs, draft and full profiles. Verified documentation-only PRs and main pushes avoid runtime stacks; drafts check types/lint without databases or browsers. Ready non-documentation PRs and main pushes retain complete application/HTTP verification, with tracker, release and production-image/runtime checks selected by their actual inputs. Unknown or incomplete impact forces every scope. Add the `ci:full` label to request full verification while an integration PR stays draft. Stable required gates always report, and obsolete runs cancel only within the same PR/workflow. Every release candidate separately requires successful full application and production-image/runtime verification for its exact source, current target, policy and public build inputs; a scoped main aggregate cannot approve a release. See [CI profiles, fixture decisions and timing evidence](docs/ci.md).

After changing a migration, run `npm run db:types` and commit the result. Coding conventions that need judgement rather than a check are in [`CODING_STANDARDS.md`](CODING_STANDARDS.md).
