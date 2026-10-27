---
name: run-app
description: Run iVAT and verify a change in the running app. Use when asked to run, start, smoke-test or see the app, or to confirm a UI or route change works beyond the tests.
---

# Run the app

Each step ends when its check passes.

1. **Stack.** Work in your worktree (see `AGENTS.md`). `npm run db:start` brings up its Supabase stack and writes `.env.local`. Done when `npm run db:start` exits 0.
2. **Servers.** In the background, start the dev server on a free port (for example, `npm run dev -- -p 3100`) and `npm run worker`. If a dev server already runs for this checkout, reuse it. Record the actual `Local` URL from its banner as `APP_URL`; use this same URL for the seed, browser and Next.js MCP endpoint. Set `APP_URL` to that value in each shell that uses it. Done when the dev log prints `Ready` and the worker prints `waiting for jobs`.
3. **QA account.** `npm run dev:seed -- --base-url "${APP_URL:?Set APP_URL from the dev server banner}"`. It prints a fresh account's email and password, the Company and Source File URLs, and a `Cookie:` header. The worker turns the Source File into two Documents in review within seconds.
4. **Drive it.** Visit every page and route the change touches.
   - **Browser:** when `agent-browser` is on `PATH`, use the `next-dev-loop` skill and sign in with the seeded account. Forms and server actions (correcting, approving, uploading) can only be exercised this way.
   - **HTTP:** otherwise, `curl -s -H "Cookie: <seeded cookie>" <url>` fetches pages and content routes as the QA user. Strip tags with `sed 's/<[^>]*>/ /g'` to read the text. Report which interactions stayed unverified.
   - **Server errors:** the dev server logs JSON lines to `.next/dev/logs/next-development.log`; `grep '"level":"ERROR"'` it after loading pages. (`next-dev-loop` reads browser errors too.)
   Done when each touched page renders what the change promises and the log holds no new errors.
5. **Clean up.** Stop the dev server and worker you started.

## Gotchas

- A throwaway script resolves `@/` imports and `node_modules` only from inside the repo. Prefer extending `scripts/dev-seed.ts`.
- `npm run build` rewrites `.next`, which a running `next dev` depends on; build only after stopping the dev servers of this checkout.
- `npm run db:reset` deletes the stack's data; run it only in your own worktree, after changing a migration that is already applied. Stop that worktree's dev server and worker before resetting. After the reset succeeds, repeat steps 2–3 and sign in with the new QA account. Done when the new account can access its Company and its Documents reach review.
