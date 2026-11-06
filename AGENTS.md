## Agent skills

### Issue tracker

Issues are tracked in the GitHub Issues of Thomisso/iVAT (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Multi-ticket implementation

Specs implemented through parallel tickets use the review gates and test-budget workflow in `docs/agents/implementation-workflow.md`.

### Agent progress reporting

When starting or reporting implementation work, use the shared tracker commands and setup/activation rules in `docs/agents/agent-tracking.md`.

## Working copy

Build a ticket in its own git worktree (`git worktree add ../iVAT-<ticket> -b <branch>`, then `npm ci` and `npm run db:start`). The main checkout's database, dev server and branch belong to the human working there; a worktree gets its own Supabase stack, so `db:reset` and tests touch only yours. See "Git worktrees" in `README.md`. Run its dev server on a free port (`npm run dev -- -p 3100`).

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
