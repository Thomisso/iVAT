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

Uploaded Source Files wait until the Company enables AI processing on its page. Locally, `AI_PROVIDER=fake` (the default `db:start` writes) Splits every page into its own Document and returns a sample Extraction, so no Document leaves your machine.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run db:start` / `db:stop` | Start or stop the local Supabase stack; `db:start` also writes its URL and keys to `.env.local` |
| `npm run db:migrate` | Apply new migrations to the local database, keeping its data. A migration already applied is not re-run: after editing one, use `db:reset` |
| `npm run db:reset` | Recreate the local database from `supabase/migrations/` (deletes all local data) |
| `npm run db:types` | Regenerate `src/lib/database.types.ts` from the local schema after a migration |
| `npm run dev` | Next.js dev server |
| `npm run worker` | Worker process (restarts on change) |
| `npm run typecheck` | Generate Next route types, then run `tsc` |
| `npm run lint` | ESLint |
| `npm test` | Application-layer tests; requires `npm run db:start` |
| `npm run build` | Production build |

## Layout

```
src/application/   commands and queries; each takes a Supabase client acting as a user (AppClient),
                   plus the background job handlers (processing.ts) and the AI provider interface
src/ai/            AI provider adapters (so far the scripted fake) and selection by AI_PROVIDER
src/app/           Next.js routes and server actions, thin wrappers over src/application
src/i18n/          locale config; messages are in messages/{cs,en}.json
src/proxy.ts       session refresh and login redirect
supabase/          CLI config and SQL migrations (schema, RLS policies, audit triggers)
worker/            background job runner
tests/             application-layer tests against the local database
```

## Tenancy, security and audit

- Organization → Company → Membership ([ADR-0001](docs/adr/0001-organization-tenant-with-shared-postgres-rls.md)). Every tenant-owned table carries `organization_id` (and `company_id` where applicable). RLS policies derive access from the user's Memberships. An Organization Administrator can access all of the Organization's Companies.
- Sign-up is handled in the database: a trigger on `auth.users` creates the Organization and the Administrator Membership in the same transaction.
- `audit_event` is append-only. Only database code writes to it (`private.record_audit_event`, called from triggers). Users can only read it, and only as an Organization Administrator. Update, delete and truncate are rejected for every role.

## Processing

Uploading a Source File enqueues a Split job (pg-boss). The worker Splits the file into Documents through the AI provider, then runs one Extract job per Document. Each Extract job stores an immutable Extraction Version and moves the Document to NeedsReview ([ADR-0004](docs/adr/0004-split-then-extract-with-multimodal-llms.md), [ADR-0005](docs/adr/0005-immutable-extraction-versions.md)).

- Statuses: a Source File is `uploaded → processing → split`, and each Document is `uploaded → processing → needs_review`. Either ends in `failed` once a technical error has used up its retries. A failed Split can be retried. A failed or reviewed Document can be reprocessed, which adds a new Extraction Version.
- No job calls the AI provider unless the Company has enabled AI processing for that provider and region ([ADR-0006](docs/adr/0006-ai-credentials-and-data-sharing-consent.md)). Enabling and disabling are audited.
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

## CI

`.github/workflows/ci.yml` runs on every pull request and on `main`. It checks that `package-lock.json` matches `package.json` and, on a pull request, that no migration already on `main` was changed, renamed or deleted. It then starts local Supabase, checks that `src/lib/database.types.ts` matches the migrations, then runs typecheck, lint, tests and build. After changing a migration, run `npm run db:types` and commit the result. Coding conventions that need judgement rather than a check are in [`CODING_STANDARDS.md`](CODING_STANDARDS.md).
