# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Decision map

Read the ADR named by the branch you are changing:

- Organization, Company, Membership or tenant isolation → `0001-organization-tenant-with-shared-postgres-rls.md`
- stack, Supabase or local development → `0002-typescript-supabase-stack-local-first.md`
- AI proposals or deterministic tax outcomes → `0003-ai-extracts-rules-engine-computes.md`
- Split/Extract jobs or processing order → `0004-split-then-extract-with-multimodal-llms.md`
- Extraction Versions → `0005-immutable-extraction-versions.md`
- AI consent, provider selection or credentials → `0006-ai-credentials-and-data-sharing-consent.md`
- Finalization or Period Locks → `0007-finalization-locks-reporting-period.md`
- Roles, authorization, RLS or security-definer RPCs → `0008-database-is-the-authority-for-access-and-roles.md`
- audit payloads or User identity → `0009-audit-log-holds-no-personal-data-of-users.md`
- worker privileges, `SystemClient`, idempotency or job payloads → `0010-worker-acts-as-service-role-through-narrow-grants.md`
- a Document's Reporting Period, Tax Point Date or Deferred Claim → `0012-reporting-period-follows-tax-point-date.md`
- Reporting Years, filing frequency or period generation → `0013-reporting-years-are-generated.md`

## File structure

Single-context repo (most repos):

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `GLOSSARY-MAP.md` at the root):

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
