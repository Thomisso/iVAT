# CLI processes and evidence

The execution rule in [AGENTS.md](../../AGENTS.md#agent-execution) applies to implementation, review, research, testing, tracking, deployment, recovery and every local or external skill used in this repository. Apply it before following a skill's tool requirements. Read documentation through files, CLI help or HTTP; inspect services through supported APIs and commands.

This includes automated browser suites launched from CLI or CI. The current
production acceptance command is `npm run test:http` (`test:e2e` is a compatible
alias for that same HTTP runner). Historical Playwright files remain source
inventory; older browser-execution instructions are superseded by this policy.
They cannot be invoked to complete an agent or CI gate.

## Choose an observable command

Use the existing application commands and queries as real users against the worktree's real database, authenticated HTTP requests to the app, server logs, applicable repository tests and server-capable Next.js MCP tools. [next-dev-loop](../../.agents/skills/next-dev-loop/SKILL.md) defines runtime verification; [run-app](../../.claude/skills/run-app/SKILL.md) starts the isolated app. Keep the checked revision, command, result and observed durable state together.

HTTP content checks establish the returned status, headers and content. They do not establish client hydration, clicks, focus, responsive layout, React render counts or visual correctness. Compilation and server logs do not prove those behaviors either. Use existing applicable evidence for the claim it actually establishes; mark required unproven behavior outstanding. Never relabel a forbidden or unavailable check as passed, or claim visual inspection from HTML/source inspection. Retain the existing review, test-budget and exact-revision gates in [implementation-workflow.md](implementation-workflow.md).

The versioned `next-dev-loop` is a project-maintained adaptation of the upstream skill identified by `skills-lock.json`. Preserve this execution policy when importing future upstream changes. A browser tool dependency in an external skill is a process conflict, not a reason to install it, upgrade the app or stop work that has a supported CLI/API path.

## External services and credentials

Use an existing authorized CLI session, resource identifier and credential from a protected input or secret store. Verify supported commands from installed `--help`, source or the provider's current primary documentation before use. Disable automatic browser launch where a supported unattended mode exists. Do not run an interactive login whose completion requires a web page.

If an operation has no supported non-GUI interface, report its exact missing capability and the existing credential/resource input needed to proceed. Continue independent work. Do not invent an API, bypass authentication or MFA, direct someone to a console, or ask them to perform a GUI step. Missing permissions and missing provider features remain explicit limitations; they are not successful configuration or evidence.

Use `gh` and the shared serialized tracker for GitHub operations, as documented in [agent-tracking.md](agent-tracking.md). In particular, verify native Project columns by API readback and planned issue references by API before merge; actual PR-caused issue closure remains the delivery criterion. An unexposed repository checkbox is not a required preflight observation.

For provider-specific setup and operations, follow the CLI/API paths and capability boundaries in [deployment.md](../deployment.md) and [google-sign-in.md](../google-sign-in.md). Those processes consume existing credentials; they do not require creating credentials through a browser.

Product documentation may describe the application's user-facing browser flows. Historical verification records retain the tools and observations actually used at that time. Neither supplies permission or a requirement to use those tools in a future agent process.
