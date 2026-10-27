# Coding standards

Judgement calls for review. CI already enforces typecheck, lint, tests, build, generated database types and the lockfile, so these rules cover what no check can.

## Application layer

- Business behaviour lives in `src/application/`. Every command and query takes an `AppClient` acting as the user as its first argument, so RLS applies to everything it does. Routes and server actions stay thin: read the input, call one command or query, map the result.
- Expected refusals are returned as `Result` (`{ ok: false, error: "<code>" }`), never thrown. Error codes are snake_case, and each has a message under `errors` in both `messages/cs.json` and `messages/en.json`. Unexpected failures are thrown.
- The command translates Postgres error codes into refusals (for example `42501` → `forbidden`, `23505` → `*_taken`), so callers never see database codes.
- Values leaving `src/application/` are camelCase domain objects. Snake_case rows stay inside.

## Database

- A tenant-owned table carries `organization_id` (and `company_id` where applicable), has RLS enabled, and its policies are built from the `private.*` access predicates. Privileges start from `revoke all … from anon, authenticated`, then grant only what the application uses. Insert grants list their columns.
- Access predicates and trigger functions live in the `private` schema, as `security definer` with `set search_path = ''`. `execute` is revoked from `public`. `authenticated` gets `execute` only on predicates that policies call.
- Auditable actions write through `private.record_audit_event` from database code (a trigger or a security-definer function). Action names read `<target>.<past-tense verb>` (`company.created`).
- A migration that has reached `main` is history: change the schema by adding a new migration.

## Tests

- Tests call `src/application/` as real users, using the fixtures in `tests/support/`. They assert on what that user observes through queries. A direct table query belongs in a test only to prove that the database itself refuses something under the user's identity (isolation, audit).
- Every new tenant-owned table gets an isolation test: a user of another Organization can neither read nor modify its rows, including through direct queries.
- Expected values are literals from the spec or a worked example, never recomputed the way the code computes them.

## UI

- Every user-visible string goes through next-intl, with the key present in both `cs` and `en`.
- A form driven by `useActionState` gets back `FormState` holding the submitted values (passwords excluded) and renders them as `defaultValue`. React resets a form after its action runs, so this is what keeps a refused form's input.

## Language

- Names in code, tests, error codes and audit actions use the terms in `GLOSSARY.md` and follow its _Avoid_ lists.
