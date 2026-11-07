---
name: next-dev-loop
description: >
  Verify Next.js runtime behavior after editing app code through authenticated
  HTTP, server-capable Next.js MCP tools, logs and application checks against
  the worktree's real database. Use with a running next dev server.
---

# Next.js runtime verification

Follow [AGENTS.md](../../../AGENTS.md#agent-execution) and the
[CLI process and evidence rules](../../../docs/agents/cli-processes.md).
This project-maintained skill verifies observable runtime behavior through
CLI and HTTP. It has no browser-tool or framework-upgrade preflight gate.

## Prepare the running app

1. Read the relevant installed Next.js guide in `node_modules/next/dist/docs/`
   before changing framework code. Inspect the installed package and scripts
   rather than assuming a version or bundler.
2. Use this ticket's worktree and Supabase stack. Start or reuse only that
   checkout's dev server on a free port and worker when the scenario needs it.
   The [run-app skill](../../../.claude/skills/run-app/SKILL.md) covers setup
   and real QA-account provisioning. Record the actual URL from the server
   banner; use it for all HTTP requests and `/_next/mcp` calls.
3. Define the changed behavior and its observable success and refusal cases.
   Select the public route and existing application command/query or focused
   test that can establish each case under a real user's identity.

Done when the intended worktree, URL, authenticated test identity and required
real services are identified and reachable. A missing service is a specific
runtime limitation, never a successful check.

## Discover server capabilities

Probe `/_next/mcp` over HTTP with `tools/list` when that endpoint is available.
Use only the tools actually advertised by this server whose execution does
not require a browser session. Depending on the installed version, useful
server tools include `get_project_metadata`, `get_routes`, `get_logs`,
`get_server_action_by_id` and `get_compilation_issues`.

If the endpoint or a tool is unavailable, continue with the matching HTTP,
server-log and application-check path and state which introspection was
unavailable. A Turbopack-only compilation tool cannot establish compilation
on another bundler; use the actual compiler result instead. Do not upgrade
Next.js or install browser tooling merely to satisfy this skill.

`get_errors` and `get_page_metadata` may depend on a browser session. Do not
invoke browser-dependent tools or interpret absent/empty session data as proof
of no errors. An MCP wrapper's browser-control tools are outside this workflow.
For SSE replies, parse JSON from `data:` records rather than the `event:` line.

## Verify the change

1. **Compilation:** inspect available server compilation diagnostics and the
   actual dev-server output for the affected routes. Typecheck/build results
   support their own claims; they do not establish successful runtime behavior.
2. **HTTP:** request each affected page, content route or API under the seeded
   user's real session. Check the expected status, redirects, headers and
   relevant returned content, including the applicable refusal case. Keep
   session material in protected local input and out of reports and Git.
3. **Application behavior:** use existing commands, queries and focused tests
   against real Auth, Postgres and RLS to verify changed mutations and durable
   results. Exercise them as the actual user through `AppClient`; use the
   worker's genuine handlers for jobs. Observe a terminal result instead of
   treating an enqueued job, transient alert or arbitrary delay as completion.
   Application-layer proof does not itself prove form submission or client UI.
4. **Errors:** inspect the worktree's dev-server and worker logs after the
   scenario. Correlate relevant new errors with the request; an empty server
   log does not establish an error-free client session.

Done when each selected case has its actual result and the unchanged evidence
requirements are met. Report required cases that these interfaces cannot
establish as outstanding, with the precise limitation. Do not manufacture a
runtime pass, visual claim or justified-applicability result to satisfy a gate.

## Preserve and clean up

Preserve `.next` while its dev server runs. Moving or deleting it also resets
the server's generated state. Stop that server before a production build, or
use an explicitly configured separate output directory. Stop only the server
and worker started for this verification; retain an already-running worktree
server. Keep the human checkout and its database untouched.

For production HTTP acceptance, run `npm run test:http` in an isolated worktree.
It builds and starts the production app, uses real Auth/database/worker paths,
executes the CLI HTTP suite and tears down the owned services/stack. It never
executes the retained browser test inventory. `npm run test:http:dev` is a
focused development alternative; it does not supply production-build evidence.

Report the exact revision, commands/tools, observed outcomes and remaining
limitations. Treat existing test evidence according to its scope and revision;
source inspection, successful compilation and HTTP checks cannot prove
hydration, click behavior, responsive layout, screenshots or React render counts.
