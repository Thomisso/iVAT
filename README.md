# iVAT

iVAT turns financial documents uploaded by Czech VAT payers into validated, structured data and produces the Czech VAT Return and Control Statement for a Reporting Period. Domain terms are defined in [`GLOSSARY.md`](GLOSSARY.md), and architectural decisions are recorded in [`docs/adr/`](docs/adr/).

## Stack

- **Next.js** (App Router, TypeScript) serves the UI and server actions.
- **Worker** (`worker/`): a separate Node process that runs background jobs on **pg-boss**.
- **Supabase**: Postgres with Row-Level Security, and Auth. Locally, everything runs through the Supabase CLI ([ADR-0002](docs/adr/0002-typescript-supabase-stack-local-first.md)).
- **next-intl** handles i18n in Czech (default) and English. The language is a per-browser cookie.

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

Open http://localhost:3000/signup. Signing up creates your Organization, makes you its Administrator, and takes you to create your first Company. Local email confirmation is off, so you are signed in right away. Supabase Studio runs at http://127.0.0.1:54323.

Email/password sign-in works without third-party credentials. To enable Google
sign-in locally, follow [`docs/google-sign-in.md`](docs/google-sign-in.md).

New Companies receive the platform's default AI Configuration and a lifetime allowance of 50 successful Extractions. A SuperAdmin can change assignments, access and allowances; Company users only see their allowance and waiting-Document status. Locally, `AI_PROVIDER=fake` (the default written by `db:start`) Splits every page into its own Document and returns a sample Extraction, so no Document leaves your machine. Set `AI_PROVIDER=platform` for per-Company Anthropic/OpenAI routing through SuperAdmin-owned configurations.

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

All `db:*` scripts go through `scripts/supabase.mjs`. In the main checkout it uses `supabase/config.toml` as is. A linked git worktree gets its own stack instead: a separate database, ports shifted by 100 × a slot derived from the worktree path, and no Studio, Mailpit, analytics or edge runtime. Parallel worktrees can reset and test their databases independently. If two worktrees land on the same slot, set `SUPABASE_SLOT` (1–99) for one of them. Run `npm run db:stop -- --no-backup` before removing a worktree to delete its stack's data.

## Testing

Tests exercise the application layer as real users against the local Postgres with RLS enabled, per the seams in the requirements' Testing Decisions. Background jobs run synchronously through the worker's own handler (`testWorker` in `tests/support/worker.ts`), against a scripted fake AI provider. Tests create their own users and Organizations, so they need no reset between runs:

```bash
npm run db:start
npm test
```

The end-to-end acceptance suite stops this worktree's existing Supabase stack
without retaining its data, starts only the services needed by the browser
tests, builds the production Next.js application, and runs it with the worker
and fake AI provider. Install Chromium once after `npm ci`, then run the same
production-mode suite used by CI:

```bash
npx playwright install chromium
npm run test:e2e
```

For a faster local loop that uses `next dev` and skips the production build,
run `npm run test:e2e:dev`; use the production-mode command for final
verification. The suite covers authentication and invitations, Company and
Platform administration, uploads and background remediation, reporting and
exports, responsive shell behavior, and accessibility. It does not call a real
AI provider or another external network service. On failure, Playwright traces
and separate Next.js, worker, and Postman logs are retained under
`test-results/`.

The real-provider extraction evaluation is a separate manual command. Its
versioned golden-set format, credentials, model overrides, scoring rules, and
illustrative fixtures are documented in
[`evaluation/golden-set/README.md`](evaluation/golden-set/README.md).

## CI

`.github/workflows/ci.yml` runs on every pull request and on `main`. It checks that `package-lock.json` matches `package.json` and, on a pull request, that no migration already on `main` was changed, renamed or deleted. It then starts local Supabase, checks that `src/lib/database.types.ts` matches the migrations, and runs typecheck, lint, tests and build. A separate job installs Chromium and runs the end-to-end acceptance scenario. After changing a migration, run `npm run db:types` and commit the result. Coding conventions that need judgement rather than a check are in [`CODING_STANDARDS.md`](CODING_STANDARDS.md).
