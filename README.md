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
cp .env.example .env.local   # local Supabase defaults; `npx supabase status` prints them
npm run db:start             # start local Supabase (applies migrations on first start)
npm run dev                  # app on http://localhost:3000
npm run worker               # background worker, in a second terminal
```

Open http://localhost:3000/signup. Signing up creates your Organization, makes you its Administrator, and takes you to create your first Company. Local email confirmation is off, so you are signed in right away. Supabase Studio runs at http://127.0.0.1:54323.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run db:start` / `db:stop` | Start or stop the local Supabase stack |
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
src/application/   commands and queries; each takes a Supabase client acting as a user (AppClient)
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

## Testing

Tests exercise the application layer as real users against the local Postgres with RLS enabled, per the seams in the requirements' Testing Decisions. They create their own users and Organizations, so they need no reset between runs:

```bash
npm run db:start
npm test
```
