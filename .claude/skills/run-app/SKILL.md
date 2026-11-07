---
name: run-app
description: Run iVAT and verify routes and application behavior through CLI and authenticated HTTP. Use when asked to run, start or smoke-test the app, or confirm a change works beyond compilation.
---

# Run the app

Follow [AGENTS.md](../../../AGENTS.md#agent-execution) and the
[CLI process and evidence rules](../../../docs/agents/cli-processes.md).
Each step ends on its observed result.

1. **Stack.** Work in your worktree. `npm run db:start` brings up its Supabase stack and writes `.env.local`. Done when it exits 0.
2. **Servers.** Start the dev server on a free port (for example, `npm run dev -- -p 3100`) and `npm run worker` in the background. Reuse an existing server only for this checkout. Record the actual `Local` URL from its banner as `APP_URL`; use it for the seed, HTTP requests and Next.js MCP endpoint. Done when the dev log prints `Ready` and the worker prints `waiting for jobs`.
3. **QA account.** Run `npm run dev:seed -- --base-url "${APP_URL:?Set APP_URL from the dev server banner}"`. It privately provisions and signs in a real account, uploads a Source File and prints account/Company/Source URLs and a session cookie. Keep those credentials and cookies private. Observe the Source File reaching its expected terminal state through the application query as the QA user; elapsed seconds alone do not establish completion.
4. **Verify.** Follow [next-dev-loop](../../../.agents/skills/next-dev-loop/SKILL.md) for authenticated HTTP requests, server-capable MCP tools and focused application checks against the real database. Check each affected route's returned status/content and relevant new server/worker errors. Use existing application commands and queries as the QA user to verify mutations and durable results. Record which form/client behaviors remain unverified; HTTP page reads and application commands do not prove clicks, hydration or visual layout. Done when the selected cases have actual results and any required unproven behavior is explicitly outstanding.
5. **Clean up.** Stop only the dev server and worker you started.

## Gotchas

- A throwaway script resolves `@/` imports and `node_modules` only from inside the repo. Prefer existing scripts and application test fixtures.
- `npm run build` rewrites `.next`, which a running `next dev` depends on; build only after stopping this checkout's dev server, or configure separate output.
- `npm run db:reset` deletes the stack's data. Run it only in your own worktree after changing an already-applied migration, with that worktree's dev server and worker stopped. Then repeat setup and QA provisioning; old credentials and cookies are not evidence that the reset stack works.
