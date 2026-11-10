# Pilot deployment on Roští

Agent operations follow the [CLI process and evidence rules](agents/cli-processes.md). Use existing authorized credentials and supported CLI/HTTP interfaces for every step; unavailable provider capabilities remain explicit limitations.

The pilot runs Next.js, the Worker and self-hosted Supabase in one Roští Stack.
The application is at `https://app.ivat.cz`; the public Supabase API is at
`https://api.ivat.cz`. DNS stays at WEDOS with DNSSEC. AI uses the existing
platform-owned provider configurations.

Keep the actual Stack identity, SSH connection details, deployed revisions,
verification results and backup inventory in protected operator records outside
Git. The [private deployment record notice](deployments/2026-10-30-rosti-pilot.md)
explains the separation from this reusable procedure.

This is a pilot exception to ADR-0002's original managed Supabase choice.
Roští manages its hosting infrastructure; we maintain the application images,
Supabase versions, backups and recovery. Medium (4 GB RAM, 25 GB disk) is an
initial trial profile, conditional on measured memory, disk, PID limits and
upload behavior. See [upstream versions and adaptations](../deploy/UPSTREAM.md).

## Server Supabase transport

`SUPABASE_INTERNAL_URL` selects the private HTTP gateway for web request clients,
session verification/refresh, ordinary Auth and their database/Storage requests.
`NEXT_PUBLIC_SUPABASE_URL` remains the SDK's public identity: cookie names and
settings, PKCE, OAuth authorization URLs and generated signed Storage URLs retain
that identity. Browser access continues to use the public address. The fetch
boundary does not route WebSocket/Realtime connections.

The configured server fetch rewrites only the exact public origin and base path,
preserves the request path/query and refuses redirects out of the private hop.
An unavailable gateway never triggers a retry through the public URL. The session
proxy refuses protected content with a translated, uncached 503; failed native
logout and refresh preserve the existing browser cookies so the same session can
be verified after recovery. An account query that fails after proxy verification
returns a refusal to the stateless `/auth/unavailable` surface. That surface
performs no session or policy queries; its Retry link re-enters the normal native
verification and MFA gates, so a targeted query outage cannot create a login/MFA
redirect loop. No successful dependency check substitutes for MFA or
database authorization. Worker-only SystemClient privileges remain unchanged.

For host-run development, omit `SUPABASE_INTERNAL_URL` and use the CLI-generated
local URL. The focused local transport regression uses real Auth/Storage plus an
HTTP gateway with injected failures, including unusable public DNS/TLS paths:
`SUPABASE_SLOT=<own slot> npm test -- tests/internal-supabase-transport.test.ts`.
The CLI production HTTP acceptance runner exercises private transport through
the existing loopback real-Supabase gateway, including Auth failure, session
preservation and recovery. Run `npm run test:http` in an isolated worktree;
its build, server, worker and disposable stack are owned and cleaned up by the
runner. Historical `e2e/internal-*-transport.spec.ts` browser journeys remain
source inventory; their browser commands are superseded by this HTTP process.

## Web liveness and Auth dependency availability

`GET /health/live` returns HTTP 200 with `{"status":"ok"}` when the web process
can serve requests. It bypasses session refresh, recovery-state and MFA policy
queries, including when a caller sends existing session cookies. The web
container's healthcheck uses only this endpoint. Auth degradation must not be
used to restart an otherwise live web process. The proxy's `/healthz` checks
only the proxy process; it does not establish web or Auth availability.

`GET /health/auth` separately returns HTTP 200 with `{"status":"available"}` or
HTTP 503 with `{"status":"degraded"}`. Every request performs an uncached,
read-only Auth settings GET through `serverSupabaseFetch`, using the same public
identity and configured internal gateway as server Auth operations, with a
three-second deadline and no public fallback or redirect following. The body is
discarded. The probe uses only the publishable key, never a User's credentials,
cookies or session, and does not sign in, refresh, log out, send mail or write
Auth data. Both endpoints send `Cache-Control: no-store`; their machine statuses
are language-independent and expose no URLs, settings, identities or failure
details. Existing User-facing outage messages remain translated in CS and EN.

An available dependency result establishes read-only gateway-to-Auth reachability
at that instant. It does not prove password login, mail delivery, public browser
access, database/MFA policy availability or a complete authentication workflow.
Those workflows remain covered by the Auth, Invitation and recovery tests. Query
the dependency endpoint separately for diagnostics; do not use it as a liveness
or automatic-restart condition. There is no new polling/monitoring service.

Local regression (isolated worktree, no other Next process in this checkout):
`npm run test:http`.
This exercises real local Auth through the runner-owned loopback gateway under
injected HTTP 503 refusal and stalled forwarding requests. It checks bounded
degraded dependency responses, fail-closed protected-page refusal, no cookie
rewrite in fault responses, independent liveness and recovery.

## Prepare the release

Use an isolated git worktree, leaving the main checkout's database and server
alone. Install Docker and Node.js 22+, then:

```bash
npm ci
node deploy/scripts/init.mjs
```

The initializer creates `.env.rosti` with fresh credentials and mode 0600. It
refuses to overwrite the file. Keep it outside Git and Docker build contexts,
and retain a private recovery copy. Changing database passwords or the JWT
secret on an existing installation is a separate rotation procedure, not a
reason to re-run initialization. The pilot uses supported legacy JWT API keys;
`ANON_KEY` is public, `SERVICE_ROLE_KEY` and `JWT_SECRET` are private.

The initial pilot intentionally has no SMTP service. The operator creates the
three pilot Users explicitly; they sign in with email and password. Email
invitations and email password recovery are unavailable. Public sign-up is
disabled. Before enabling email, fill in the SMTP settings in `.env.rosti`
and configure SPF, DKIM and DMARC with the sending provider. Google OAuth
needs its own provider setup before it is enabled.


Invitation delivery uses the web application's SMTP transport with the same
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_ADMIN_EMAIL` as Auth.
Port 465 uses implicit TLS; other production ports require STARTTLS. Keep the
mailbox password in the private runtime environment. Auth sends password recovery
mail; Invitation mail contains a separate seven-day application link and creates
no Auth account until explicit acceptance. The web server's Auth administration
key is exposed only through the database-authorized adapter described in
[ADR-0016](adr/0016-invitations-authorize-narrow-auth-administration.md).

Native email OTPs, including password recovery, expire after 3600 seconds in
both CLI and production Auth configuration. Invitation capabilities retain their
separate seven-day lifetime. The proxy serves `recovery.html` only on its private
template listener; Auth uses the canonical `/password/reset` redirect with a
fragment carrying both the private request capability and native token hash.
Opening the link is read-only. Explicit verification establishes the real Auth
session; enrolled Users must verify their authenticator or complete the restricted
prepared-code replacement below before changing their password. Reset success
keeps that session and revokes other refresh
sessions; already-issued access JWTs retain their normal short lifetime.
Allow only the configured application origin for recovery redirects. Production
delivery proof must include the captured recipient email and completed reset,
alongside the separate Invitation onboarding proof.

GoTrue's configured template and subject are shared across requests. Native
recovery and MagicLink emails therefore include both Czech and English copy,
with both language links carrying the same native single-use token. Source text
lives in `authEmails.recovery` and `authEmails.magicLink` in the next-intl
catalogs `messages/cs.json` and `messages/en.json`. After editing that text, run
`npm run auth:templates`; `node scripts/generate-auth-templates.mjs --check`
verifies the committed CLI/proxy HTML and both subject configurations. The normal
messages test runs this consistency check in CI. Generation writes files in
place; the existing local-stack wrapper preserves its live template mounts.
Localization adds no environment variable and does not replace Auth's mailer,
token expiry, session verification or MFA authority.

Lost-authenticator recovery uses prepared backup codes and the restricted native
factor-replacement flow described in [MFA recovery](mfa-recovery.md). It does not
enable experimental native recovery-code APIs or invalidate existing prepared
codes. The User restriction has no automatic expiry: interrupted recovery must
resume with legitimate proof, never by clearing a pending flag operationally.

After upgrading, old hash-only Invitations still work but cannot be reconstructed
for copying. An Administrator can explicitly generate a replacement, invalidating
the old link and starting a fresh seven-day window without sending mail. New
Invitations expose the same valid copied link after reload. Neither local Mailpit
capture nor successful SMTP configuration establishes production delivery; record
actual recipient delivery and completed onboarding separately.

Build and validate before deploying. `NEXT_PUBLIC_*` values are build-time
configuration; changing the public API URL or anonymous key requires a new
application build. No private key is passed as a Docker build argument.

```bash
docker compose --env-file .env.rosti -f docker-compose.rosti.yml config --quiet
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose --env-file .env.rosti -f docker-compose.rosti.yml build
```

## Connect Roští

Use an existing authorized target in the official [rosticli](https://rosti.cz/cli),
or an existing provider API credential and the exact company/Stack identifiers
from protected input. Before configuring authentication, inspect the installed
CLI's help or current provider HTTP documentation for a supported unattended
mode; do not invoke a login flow that requires a web page. If that mode is
unavailable, report the missing authenticated target/credential capability and
continue independent preparation. Keep credentials out of chat. Initialize a
target named `rosti` only through supported CLI/API inputs for the existing
company and Medium trial profile. Keep the prepared Dockerfiles and Compose file.
The deployment has four built images, including the root application image.
CLI 1.9.3's automatic multi-image discovery omits the root image and does not
recognize this Compose frontend. Use the explicit Compose build and SSH
transfer below for the initial deployment.

```bash
rosticli stacks init --target rosti --name ivat --multi --frontend proxy --disable-ai
rosticli stacks push-env --target rosti
```

`push-env` uploads `.env.rosti` to the Stack's `.env`. It replaces the remote
file, so use it only with the complete intended configuration. It does not
merge secrets. The secret file on the Stack must remain available between
releases.

The build needs the same public URL and anonymous key from `.env.rosti`.
Transfer all four images and the operator scripts, then start the services.
Use a shell with `pipefail` so a failed export or upload stops the release:

```bash
set -o pipefail
docker save app:latest app-deploy-db:latest app-deploy-gateway:latest app-deploy-proxy:latest | gzip -1 | rosticli stacks ssh --target rosti -- sh -lc 'gzip -d | docker load'
COPYFILE_DISABLE=1 tar -czf - docker-compose.rosti.yml deploy/scripts deploy/restore.yml | rosticli stacks ssh --target rosti -- sh -lc 'mkdir -p /srv/stack; tar -xzf - -C /srv/stack; chmod 600 /srv/stack/.env; cp /srv/stack/docker-compose.rosti.yml /srv/stack/docker-compose.yml'
rosticli stacks ssh --target rosti -- sh -lc 'cd /srv/stack; docker compose --env-file .env -f docker-compose.rosti.yml up -d --no-build --wait'
```

On the first deployment, stop the provider's `stack-welcome-1` container before
starting the proxy on port 80. Keep the provider's canonical
`/srv/stack/docker-compose.yml` synchronized with the release Compose file so
administration controls operate on the same services. Never modify the separate
system `mgm` service.

The provider also exposes Compose through its administration and
[`PUT /api-n/{company_id}/stacks/{stack_id}/compose?call_up=false`](https://admin.rosti.cz/api-n/docs)
with a `text/plain` body. For subsequent releases, keep the provider-managed
Compose configuration synchronized through its supported tooling as well as
the release file. During the initial rollout, the provider's returned
`compose_b64` matched the release file after upload. Recheck this after future
updates; an administration edit can replace the canonical Compose file.

Prefer `rosticli stacks ssh --target rosti -- sh -lc '...'` for host commands.
The host's default shell is fish; `sh -lc` makes the shell syntax in this
runbook predictable. The CLI maintains its own SSH host-key trust; raw
OpenSSH does not automatically inherit it.

Only the proxy publishes port 80. PostgreSQL, Auth, REST, Storage and Kong's
admin interface stay private. Store persistent data under `/srv/stack`:
`deploy/runtime/db`, `deploy/runtime/db-keys` and `deploy/runtime/storage`.
Never use `down --volumes`, `db:reset`, or pruning of persistent data as a
deployment step.

## Domain and first login

Use existing provider credentials and resource identifiers to configure
`app.ivat.cz` and `api.ivat.cz` through supported Roští CLI/HTTP operations.
At WEDOS, use its supported authenticated interface to create CNAME records
`app` and `api`, both pointing to `lb.rosti.cz`, retaining the existing NSSET
and DNSSEC. Verify the current provider contract before issuing a write; this
runbook does not establish domain-management endpoints or unattended credential
issuance. If the required operation or access is unavailable, report the exact
missing capability rather than directing anyone to Proxy settings or a DNS
console. Disable redirecting all domains to the first domain through a supported
interface: the API and application need separate Host routing. Roští must issue
HTTPS certificates for both names. Verify DNS with CLI lookups and actual TLS
with HTTPS requests; a configured hostname alone does not prove issuance.

The application proxy redirects forwarded HTTP requests to the configured
HTTPS hostname, retaining the path and query string. Internal health checks
remain available without HTTPS.

The API hostname is part of the application build; a temporary hostname must
be configured before building if it is used instead.

Roští terminates HTTPS before forwarding HTTP to the Stack's port 80; no
Certbot or public port 443 is needed inside this Compose deployment. First
issuance can be delayed by DNS validation and retry backoff. Keep confirmed
DNS stable and ask support for the last error and next retry if issuance does
not complete. A synthetic ACME-path response alone does not establish the
status of a real certificate order. See the [provider's domain guide](https://docs.rosti.cz/cs/stacks/quickstart/#nastaveni-domen).

The default `ivat-931.rostiapp.cz` hostname is assigned at Roští, but our
Nginx only serves the application and API on their configured hostnames.
`https://ivat-931.rostiapp.cz/healthz` returns `200`; `/` and `/login` return
`404` by design. That `404` is independent of TLS certificate validity.

Create the operator through the existing Stack command in a private terminal:

```bash
docker compose --env-file .env -f docker-compose.rosti.yml run --rm --no-deps web node deploy/scripts/provision-user.mjs operator@example.com --superadmin
```

This creates or reuses an Auth User and grants SuperAdmin only when the flag
is present. A new User's password is printed once; use a private terminal and
store it securely. Use the same command without `--superadmin` for pilot Users;
each receives its own Organization through the existing database trigger.
The product operator flow enrolls TOTP after sign-in and manages real AI
credentials, assignments and allowances at `/platform/ai-settings`. Agent
operations use real Auth/MFA and the existing authorized application commands
and queries through CLI/HTTP; they do not navigate that UI or bypass those
authorities. If the required operator session or supported operation is missing,
record that precise limitation before claiming live workflow verification.

Verify a real uploaded Document reaches review and the expected report/export
can be generated. Verify the full 50 MiB upload through Roští's outer proxy,
including a slow connection. Our proxy permits 51 MiB multipart bodies; it
cannot override the provider's outer limits.

## Release checks and automation

### Prepare a versioned GitHub Release

Merging a pull request into `main` does not update production. When the complete
tested state of `main` is ready to ship, prepare a draft through
`gh release create NEW_VERSION --repo Thomisso/iVAT --target EXACT_TESTED_MAIN_SHA --generate-notes --draft`.
Choose a fresh version such as `v0.2.0`, inspect the draft with
`gh release view NEW_VERSION --repo Thomisso/iVAT`, and verify its tag/target
through Git/API before publishing. After the existing activation/release review,
`gh release edit NEW_VERSION --repo Thomisso/iVAT --draft=false` publishes the
normal Release. Drafts and prereleases do not prepare production deployment.
Do not move or reuse a published version tag.

The **Release Roští pilot** workflow first resolves the tag to its exact
commit, including annotated tags, and checks that it belongs to `main`. It
requests a separate **Release candidate verification** run at that stable tag
and waits up to 60 minutes for its complete successful attempt. This run calls
the same reusable **CI** and **Deployment verification** jobs with every scope
required by `verificationPlan`, including all application shards, production
HTTP acceptance and the actual AMD64 production-image build/runtime. Ordinary
main pushes select scopes from the verified complete before/after
impact: docs-only pushes omit application/database/image stacks, and known
non-deployment tooling changes omit Docker runtime. Missing/ambiguous ranges,
shared inputs and explicit full requests still require every scope. A green
scoped/docs main aggregate is insufficient. Candidate verification has only
contents/Actions/PR read permission; it has no registry publication, provider
credentials, SSH or deployment job.

The request binds repository, exact revision and source tree, stable tag,
current main target, verification-policy digest, public build configuration and
`linux/amd64`. The image/runtime check builds with the exact selected public
URL/key and release identity while using disposable local runtime credentials.
The preparation caller checks the completed run and exact attempt, referenced
workflow revisions, every required job and execution step, and the named
`release-verification-RUN-ATTEMPT` artifact. It verifies the downloaded ZIP's
SHA-256 against GitHub's artifact digest, rejects expired or incomplete
artifacts, and rechecks the tag and current target after download. Missing,
failed, cancelled, skipped, wrong-repository, different-source, stale-target or
changed-policy/input evidence stops preparation. There is no aggregate fallback.
Publication and the production connection confirm unchanged refs and public
inputs again, and require fresh API readback of that same successful completed
attempt and existing, unexpired artifact ID/digest. The unchanged immutable
artifact digest preserves the suite proof already inspected. A rerun, including
a later successful attempt, or a deleted/expired/replaced artifact invalidates
the old receipt and requires complete evidence collection again. Re-run all candidate jobs after a failure; a partial rerun cannot
borrow successful suites from an earlier attempt.

`release-verification.yml` must be registered on the default branch before
GitHub can dispatch it, and the selected tag must contain the reusable verifier
and current policy. Do not merge partial production code to register a workflow.
The separate opt-in PR acceptance path below exercises the complete producer
before activation. GitHub documents the [default-branch dispatch prerequisite](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch),
[attempt-scoped jobs](https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2026-03-10#list-jobs-for-a-workflow-run-attempt)
and [artifact metadata/download](https://docs.github.com/en/rest/actions/artifacts?apiVersion=2026-03-10).
Their contract is not evidence that a particular run executed.

The preparation job builds the application, database, gateway and proxy
explicitly for `linux/amd64` and publishes them to the repository's private
GitHub Container Registry. Image tags contain the full commit, workflow run
and attempt; older tags are not overwritten. The release bundle references
their immutable SHA-256 digests. Web, Worker, migrations and the backup helper
share the same application image.

The verified Release tag and full revision are also passed as explicit app-image
build arguments (`IVAT_RELEASE_TAG`, `IVAT_RELEASE_REVISION`). The build writes
`src/lib/build-identity.json` before Next.js compiles, then copies that generated
source into the runtime image. Login, all account menus and newly generated XML
therefore describe the same installed build. Runtime environment changes, a newer
GitHub Release and the package version cannot relabel it. OCI labels record the
same tag and revision; image references remain immutable digests.

The checked-in metadata is `null`: local development and unversioned builds show
“Vývojová verze” / “Development version”. Both release inputs must be present and
valid when building a versioned image. A local production-image check can use
explicit build arguments without publishing an image. Deployment verification
uses the disposable tag `v0.0.0` and its checked-out revision to exercise this
build path; that test identity is never a production release.

New EPO XML identifies its software generator as `<tag>+<full-revision>` (or
`development`). This is separate from the EPO schema/serializer versions, saved
VAT Report generation and Period Lock identity. Downloading an archived XML reads
its stored bytes and hash; deploying a later release never regenerates it.

Focused identity checks:

```bash
node --test scripts/tests/release-identity.test.mjs deploy/tests/release-prepare.test.mjs
npx vitest run tests/epo-xml.test.ts tests/epo-export.test.ts tests/epo-artifacts.test.ts tests/final-epo-artifacts.test.ts
npm run test:http
```

For an explicitly versioned test build, use the real `IVAT_RELEASE_TAG` and
`IVAT_RELEASE_REVISION` build inputs and retain the HTTP/build result. Historical
`TEST_RELEASE_*` variables configure only the retained browser-source expectations;
the application never reads them. The export
regression loads two independently prepared source installations against one
isolated database and checks original draft/final bytes and hashes after the
software change, for both XML formats.

During the separate activation review, configure repository variables
`ROSTI_PUBLIC_SUPABASE_URL` and `ROSTI_PUBLIC_SUPABASE_KEY` with the existing
production public API URL and publishable/anon key. These are public build
settings. Never enter a service-role key, database password or JWT signing
secret there. The workflow refuses private service keys before building.

Read the exact workflow run with `gh run view RUN_ID --repo Thomisso/iVAT`
and download its `rosti-release-…` artifact with
`gh run download RUN_ID --repo Thomisso/iVAT --pattern 'rosti-release-*' --dir PRIVATE_BUNDLE_DIRECTORY`
to inspect the bundle. Match the run and attempt to the intended Release before
using it; an unrelated latest artifact is not evidence. It contains a manifest with the revision, version,
four image digests, public build settings and asset checksums, plus the
digest-pinned Compose configuration and deployment scripts. It contains no
production environment file. The Compose file is JSON, which is valid Compose
syntax; runtime environment placeholders remain unresolved until deployment.
Use `node deploy/scripts/prepare-release.mjs validate <extracted-directory>`
to validate a downloaded bundle. Do not add or edit files in that directory.

Production deployment is disabled by default. Until the repository variable
`ROSTI_DEPLOY_ENABLED` is exactly `true`, the deploy job is skipped and the
workflow only prepares images and artifacts. Merging this implementation does
not enable it. After the separate activation review, publishing a stable
Release runs verification, preparation and deployment automatically. A green
preparation job alone does not establish a deployed release.

If preparation fails or is interrupted, inspect the preparation and candidate
run/attempt before retrying. The preparation run retains
`candidate-request-RUN-ATTEMPT`, containing `verified-release.json.request.json`,
even when candidate verification is unfinished. Download that exact artifact
with `gh run download PREPARATION_RUN --pattern 'candidate-request-*' --dir PRIVATE_DIRECTORY`.
From the trusted policy checkout with the selected tag and current main fetched,
resume the same request without another dispatch:

```bash
node deploy/scripts/prepare-release.mjs resume PRIVATE_DIRECTORY/verified-release.json.request.json PRIVATE_DIRECTORY/verified-release.json
```

Use the existing `GH_TOKEN` session with Actions read permission. Resume checks
the same source, tag, target, policy and complete attempt. A lost dispatch
response remains ambiguous; absence of a run is not permission for an automatic
duplicate dispatch. Resolve the observed request/run state first. If the target
or policy changed, select and fully verify current inputs through a new release
preparation attempt. Each new image-build attempt retains distinct tags and an
artifact; an existing release's content is not silently replaced.

### Pre-main candidate acceptance

The `Release verification acceptance` workflow is opt-in through the
`ci:release-proof` PR label. It calls `release-verification.yml` through
`workflow_call`, so it does not require dispatch registration. It exercises the
same full application/image-runtime producer on the PR's checked merge commit,
retaining the raw API PR head separately. Its request has `purpose: acceptance`,
the caller run ID and the exact PR merge ref; production preparation,
publication and deployment reject that purpose. No production secret is passed.
This label can start substantial verification and should be used for the bounded
acceptance run, not routine PR events.

After that complete run, download its exact
`release-verification-request-RUN-ATTEMPT` artifact and validate with the current
CLI/API session:

```bash
node deploy/scripts/release-evidence.mjs inspect-acceptance PRIVATE_DIRECTORY/candidate-request.json
```

The same evidence validator requires actual successful suites and verifies the
ZIP digest, workflow/revision, raw run head, checked source, target and attempt.
This produces a non-deployable acceptance receipt. Neither workflow_dispatch nor
this acceptance run substitutes for the normal PR/push required-check event.
The November 2026 source/local checks do not establish real Actions execution:
Earlier account payment/spending refusals occurred before any step and supplied
no execution evidence. Subsequent unrelated CI startup does not establish this
candidate path. Full candidate Actions, actual image/runtime acceptance and
activation remain outstanding until the authorized bounded run succeeds.

The deployment verification workflow boots the self-hosted services and
reuses Application integration tests, in addition to the existing CI checks.
For its local counterpart, use a separate verification checkout with disposable
`.env.rosti` credentials for these commands. Do not reuse the live environment
file. The test setup changes the local default AI Configuration, and the
scenarios create test Organizations, Companies and Documents.

```bash
docker compose --env-file .env.rosti -p ivat-deploy-check -f docker-compose.rosti.yml -f deploy/tests/compose.yml up -d --build --wait
docker compose --env-file .env.rosti -p ivat-deploy-check -f docker-compose.rosti.yml stop worker
npx vitest run --config deploy/tests/vitest.config.ts tests/processing.test.ts tests/source-files.test.ts tests/ai-configurations.test.ts
```

The test override exposes only loopback ports 3182 and 3183, enables test
sign-ups and uses a named Storage volume because Docker Desktop on macOS does
not preserve Linux extended attributes on bind mounts. Do not use the override
for the live Stack. Tests use scripted AI and registry adapters, not paid AI
calls. Production Storage requires a filesystem supporting extended attributes.

### Activate separately after review

Keep foundation PR #152 and the automation integration PR as separate reviews.
Merge them through the normal review process; do not activate from an unmerged
branch. The first automated Release must select a tested `main` revision that
contains the reviewed automation and foundation.

Before enabling anything, review these concrete prerequisites together:

1. Confirm Stack `931`, company `7895`, root `/srv/stack`, current `.env`,
   host Bash, `flock` supporting `-n`, `setsid`, `timeout` supporting `-s TERM`, Docker Compose and free disk space.
   Read the running database container's `com.docker.compose.project` label
   privately and retain that exact project name. Do not guess a new project.
2. Verify the SSH endpoint and host key fingerprint against a trusted provider
   channel or an already independently verified connection. Prepare the pinned
   OpenSSH `known_hosts` entry, including `[host]:port` for a nonstandard port.
   An unchecked `ssh-keyscan` result is not host verification.
3. Create reviewed SSH access and a Roští API key limited as the provider allows
   to the existing Stack/company. Keep private `.env` and Vault values on the
   Stack. The workflow never downloads or replaces them.
4. Verify the latest `Daily Roští backup` workflow run, the newest completed daily
   `.tar.gz` plus matching `.images.json`, age at most 26 hours, gzip integrity,
   and seven-day retention. Confirm previous revision/image records are present
   and there is no unresolved deployment. No extra release backup, computer
   copy or external destination is required.
5. Configure the following repository values through `gh variable set NAME --repo Thomisso/iVAT < REVIEWED_VALUE_FILE` and `gh secret set NAME --repo Thomisso/iVAT < PROTECTED_SECRET_FILE`. Read non-secret values back with `gh variable list`; a secret-name listing establishes presence only, and actual authorized workflow execution establishes usable access. This setup uses repository values and does not require a paid GitHub environment feature.

| Kind | Name | Reviewed value |
| --- | --- | --- |
| Variable | `ROSTI_PUBLIC_SUPABASE_URL` | Existing public API origin |
| Variable | `ROSTI_PUBLIC_SUPABASE_KEY` | Existing public publishable/anon key |
| Variable | `ROSTI_SSH_HOST`, `ROSTI_SSH_PORT`, `ROSTI_SSH_USER` | Independently verified SSH endpoint |
| Variable | `ROSTI_COMPOSE_PROJECT` | Existing running Compose project label |
| Secret | `ROSTI_SSH_KEY` | Dedicated reviewed SSH private key |
| Secret | `ROSTI_SSH_KNOWN_HOSTS` | Independently verified pinned host entry |
| Secret | `ROSTI_API_KEY` | Separate Roští API credential |
| Variable | `ROSTI_DEPLOY_ENABLED` | Leave unset/`false` until activation approval |

The deploy step alone receives these production secrets. Its short-lived
`GITHUB_TOKEN` has `packages: read`; confirm that the repository-associated
GHCR packages permit this token to pull all four images. No permanent registry
password is required on the host. The preparation job has package write access
but receives no production credentials.

Finally, after the explicit activation review, set `ROSTI_DEPLOY_ENABLED` with
`gh variable set ROSTI_DEPLOY_ENABLED --repo Thomisso/iVAT --body true` and
publish one monitored stable Release through the CLI path above. Read its exact
Actions run through `gh run view`/`gh run watch RUN_ID --exit-status` and verify
public HTTPS, a real login and a representative Document workflow through
supported CLI/HTTP and authorized application commands. Preserve any required
client-only behavior as unverified; server checks do not prove a UI interaction.
The first live run still needs to establish real SSH trust/access, GHCR access,
provider API/readback behavior, cron/backup state and production routing.
Local disposable checks cannot establish those facts. Setting the flag back
to `false` prevents later deployment jobs; it does not stop a host attempt
already launched. Do not cancel a running host deployment to disable the next.

### Understand deployment status

The deploy job downloads the exact preparation and verification artifacts from
that same workflow run and attempt. It validates their Release ID, tag, full
revision, asset hashes and all four digest references before connecting. It
does not rebuild or select a `latest` artifact. It verifies the SSH host key,
uploads only the validated bundle, and launches a detached host-owned command.
The login shell may be fish; transport invokes explicit `sh` and Bash.

GitHub serializes production jobs with `cancel-in-progress: false`; a newer
Release does not interrupt an active deployment. GitHub may replace a pending
job when more Releases queue, so do not assume every queued Release will run.
The shared host backup lock remains the final authority.

The runner polls durable host status and reports success only after the host
verified the same revision, attempt and four image references. The Actions
summary shows the selected revision and, on success, the immutable image
references. A skipped deploy job means preparation only. A failed preparation
never launches deployment. A failed preflight may have no deployment attempt
directory, but its transport directory still records failure.

Each GitHub run/attempt uses `github-<run-id>-<attempt-number>`. Inspect these
public-safe files privately on the host (replace the example ID):

```bash
cat deploy/transports/github-123456-1/result
cat deploy/attempts/github-123456-1/result
cat deploy/attempts/github-123456-1/phase
cat deploy/verified-release.json
```

`running` is unfinished, `success` is verified completion, `failed` requires
inspection, and `needs-intervention` means migration cleanup cannot yet confirm
that writes stopped. Transport `host.log` and per-phase logs stay private on
the host; do not paste them or production configuration into Actions logs.
The launcher has a 45-minute host deadline including lock wait. It uses
`timeout -s TERM`, supported by both BusyBox and GNU timeout. Its termination
path lets the deployment command stop and inspect the migration container; it
never force-kills uncertain cleanup merely to meet a deadline. The observer
waits at most 50 minutes and the GitHub job at most 60. Uncertain cleanup can
outlive both while retaining the host lock for intervention.

Cancellation, timeout or an SSH failure means the runner may not know the
outcome. The detached host command continues owning its lock and records its
result even if the runner disappears. Inspect the transport, attempt, actual
containers and authoritative verified record before retrying. Never infer
unchanged production from a failed GitHub job. Re-running a failed job uses a
new attempt ID; it cannot overwrite the earlier record.

Migrations run before web and Worker start. The runner holds a session lock,
applies each migration in its own transaction and verifies previously applied
checksums before applying pending changes. Restarting it is safe. A changed or
missing applied migration stops the release. Prefer additive changes compatible
with the previous application release; restoring old application code does not
undo database migrations. The pilot runner's `ivat_deploy.migration` ledger is
separate from the local Supabase CLI ledger; preserve it during recovery and
plan an explicit history conversion before switching migration tooling.

### Inspect a running release

Run these on the Stack host, from `/srv/stack`:

```bash
docker compose --env-file .env -f docker-compose.rosti.yml ps --all
docker compose --env-file .env -f docker-compose.rosti.yml logs --tail 100 web worker
cat deploy/release-commit.txt
cat deploy/release-images.txt
```

Eight long-running application services should be healthy; `migrate` should
have exited with code 0. `backup` only runs when requested, and `system-mgm-1`
is owned by Roští. For public checks, `/login` on the application must return
200 over validated HTTPS. The API's `/auth/v1/health` without an API key can
return 401; use an authenticated probe to test API behavior. Do not print
private keys, sessions, full environment files or decrypted Vault values.

On failure, inspect the attempted phase and the prior verified record together.
A provider timeout may already have stored Compose; a migration failure may
have applied earlier migrations. The unresolved marker blocks later releases
and backup restarts until explicit joint recovery. Preserve diagnostic records
and retained image tags. Do not rerun blindly or remove the marker to bypass it.

Choose recovery together with an agent: fix forward with the retained state,
or select retained application images only after checking schema compatibility.
Application rollback does not undo migrations. Database restore is a separate
explicit decision and can discard changes made after the chosen daily backup.
Verify no migration is writing, reconcile provider and host Compose, verify
healthy services and the selected revision, then explicitly clear the unresolved
marker only after recovery is complete. Do not automatically rollback, reset
production data, regenerate credentials or prune retained images.

## Backups and recovery

The agreed pilot strategy is the existing daily cold backup on the same Roští
Stack, with seven-day retention. It briefly stops services for a consistent
snapshot. Deployment checks the latest completed archive and its image
inventory under the shared lock, requires age at most 26 hours and validates
integrity. It creates no additional pre-release backup and needs no local
computer, cloud storage or off-server copy.

The schedule is the `Daily Roští backup` GitHub workflow
(`.github/workflows/daily-backup.yml`) at 03:15 UTC. It uses the same pinned
SSH secrets and variables as the deploy job, shares its `rosti-production`
concurrency group and runs only while `ROSTI_DEPLOY_ENABLED` is `true`. On the
host it streams the reviewed `backup-lock.sh` helper and runs:

```bash
acquire_backup_lock /tmp/ivat-backup.lock 900
exec sh /srv/stack/deploy/scripts/backup-daily.sh
```

The helper waits with bounded `flock -n` retries, supported by BusyBox and
util-linux, while descriptor 9 holds the same lock through command cleanup.
Streaming it from the trusted workflow checkout also works before a release has
installed the helper on the host. Host output stays in the private `daily.log`; the workflow reports only
success or failure, and a failed scheduled run triggers GitHub's normal
workflow-failure notification. For an explicitly requested run, use
`gh workflow run daily-backup.yml --repo Thomisso/iVAT`, then identify the
resulting dispatch with `gh run list --repo Thomisso/iVAT --workflow daily-backup.yml --event workflow_dispatch`
and inspect/watch that exact run. Dispatch acceptance is not backup completion;
retain the completed archive, inventory and integrity checks above. GitHub may
start scheduled runs some minutes late.

The original host crontab entry in the provider's `system-mgm-1` never ran:
its `crond` did not pick up `/etc/crontabs/root` (`cron.update` was never
consumed, no `daily.log` appeared) and the pilot deployment of v0.3.2 was
refused for a backup older than 26 hours. Do not rely on a host crontab in
`mgm`; remove that entry so a later provider fix cannot double the service
stop. Historical computer copies in the deployment record do not create a
requirement for future releases.

For an independently requested manual backup, use the same lock; releases do
not require this extra step:

```bash
(
  . /srv/stack/deploy/scripts/backup-lock.sh
  acquire_backup_lock /tmp/ivat-backup.lock 900 || exit 1
  DEPLOY_ENV_FILE=.env sh deploy/scripts/backup.sh /srv/stack/deploy/backups
)
```

The private archive includes PostgreSQL data, database encryption keys, Storage
files and extended attributes, `.env` and Compose. The matching image inventory
identifies images but does not contain their bytes; keep retained local image
tags. Backups on this Stack cannot protect against losing the entire Stack.
This is an explicitly accepted pilot limitation. The format is not encrypted;
keep archives and inventories private and out of Git and workflow artifacts.

Restore into an empty, separate Stack using the same PostgreSQL and service
versions and a checkout of this release:

Load the retained matching images first, or rebuild that release with the
saved environment's public build values. The archive does not ship Docker
images, and the restore operator itself needs the `app` image. Do not run
`init.mjs` on the recovery target: `restore.sh` recovers the original environment
file from the archive before creating containers.

```bash
DEPLOY_ENV_FILE=.env sh deploy/scripts/restore.sh /private/backup/ivat-backup.tar.gz
```

The restore script refuses to replace an existing environment file or non-empty
data directories. It recovers credentials, creates stopped containers and
restores database data, encryption keys and Storage metadata. Start the Stack,
verify the migration ledger, decrypt a known Vault secret, download an existing
file and verify its content type, then sign in before moving DNS.

Inspect `docker compose ps` after releases. Web health checks `/login`; the
Worker updates its health file only after reaching its processing queue.
Monitor both public availability and Worker health. Keep disk usage below the
profile limit, including Docker images and seven-day backup retention. Do not automatically
prune retained recovery images.

### Controlled deployment command

A prepared release can be applied using its own `deploy/scripts/deploy-release.sh`.
Run it on the Stack host with Bash, `flock`, `timeout`, Docker and Compose:

```text
bash <extracted-bundle>/deploy/scripts/deploy-release.sh /srv/stack <extracted-bundle> <existing-compose-project>
```

The existing project name must be checked from the running containers during
activation; choosing a new name would create a separate installation. Keep
`/srv/stack` as the project directory. Never run this command in a fresh data
directory or copy a test environment file to production.

Registry access uses `GHCR_USER` and `GHCR_TOKEN`; provider synchronization uses
`ROSTI_API_KEY`. Set them privately, or set `IVAT_DEPLOY_CREDENTIALS_STDIN=1`
and stream two newline-terminated values to standard input: registry token
first, Roští API key second. Do not put either secret in command arguments,
logs or shell history. Registry credentials are kept only in a private
per-command temporary Docker configuration and removed on exit.

The command uses the shared `backup-lock.sh` helper with bounded `flock -n`
retries to acquire the same `/tmp/ivat-backup.lock` used by the daily backup
job. Before stopping services, it validates the bundle, the newest completed
daily archive and its image inventory (maximum age 26 hours), gzip integrity,
and the installation's public build settings. It creates no additional
backup and needs no local computer or external storage. A refusal at this
stage leaves the running installation and verified release unchanged.

A private attempt directory under `deploy/attempts` retains the previous
Compose configuration, provider Compose, revision records and image identities.
Old images receive retention tags before configuration changes. The command
updates provider-managed Compose with `call_up=false`, verifies readback,
stops the old web/Worker/proxy, starts core services and explicitly recreates
and runs migrations. It then starts the new application, verifies health,
checks the public HTTPS login page and compares actual selected container
image IDs. Short downtime is expected.

`deploy/verified-release.json` is the authoritative, atomically published
verified release record. Legacy revision/image text files are also updated.
Each attempt has a public-safe `phase` and `result`; detailed service logs
stay private on the host. A failed workflow is not evidence that nothing
changed: inspect the recorded phase and previous configuration together
before deciding how to recover. No application rollback or database restore
is automatic.

Before the first configuration mutation, the command writes
`deploy/.deployment-unresolved`. It is removed only after successful
verification. An unresolved attempt blocks subsequent deployments and makes
the daily/manual backup script refuse before stopping or restarting services.
This prevents the backup's restart step from accidentally starting a failed
candidate. After joint recovery, verify service health and that no migration
is still running before explicitly removing this marker. Do not remove the
marker merely to bypass an error.

If a migration times out or the host receives a termination signal, cleanup
stops its daemon-side container before releasing the lock. If Docker cannot
confirm that the migration stopped, the attempt reports `needs-intervention`
and the process retains the lock while retrying that check. Inspect the host
and migration state before terminating such a process. Cancelling a remote
runner does not establish the outcome of a host-side deployment.

For a disposable runtime check only, a marker outside `/srv/stack` and an
explicit local Compose override permit locally built image tags, loopback
ports and a named Storage volume. These overrides are rejected for the
production directory. Run the real command tests with:

```bash
node --test deploy/tests/release-prepare.test.mjs deploy/tests/release-host.test.mjs deploy/tests/release-connect.test.mjs
IVAT_RELEASE_RUNTIME_TEST=1 node --test deploy/tests/release-runtime.test.mjs
```

### Verification evidence and remaining live work

The release runtime test builds all four custom AMD64 images and exercises the
actual deployment command against disposable Compose services and a real SSH
server with pinned test host keys. GitHub workflow evidence and Roští Compose
HTTP calls use local Postman stand-ins derived from their published contracts.
The full host/SSH fixture was verified on Docker Desktop for macOS with Linux
containers. Its root operator creates private host records, so a native Linux
nonroot parent needs appropriately privileged test execution for record reads
and cleanup. This optional full runtime fixture is separate from the focused
CI tests, which were verified on Linux as a nonroot user.
This proves caller behavior in the tested scenarios, not the real provider.
The #162 fixture now prepares a complete committed source tree, including its
probe migration and annotated tag, before building the versioned target image.
It compares the installed source generator and compiled login identity with the
validated bundle. Its synthetic baseline omits only the probe migration; failure
injection still uses disposable-only overrides. The fast source-preparation
check passed during #162. After stopping the ticket stacks, final corrected
integration verification for #179 ran
`IVAT_RELEASE_RUNTIME_TEST=1 node --test deploy/tests/release-runtime.test.mjs`
at `8a8472bcd5733754bbcb6386d0e475cc9f9bf2f0` on Docker Desktop for macOS:
all three cases passed, with zero skips, in 187.75 seconds. This includes actual
pinned test SSH, interrupted-observer recovery, selected-image producer failure,
compiled tag/full revision and installed XML generator, failed-migration recovery
guards, and anonymous proxy delivery of both brand SVGs and four published icons
with exact bytes, MIME types and signatures.

The baseline contains the complete current application and omits only the
synthetic probe migration. The real view and RPC migrations therefore run during
fresh baseline preparation; the later actual deployment upgrade applies the probe.
Separate isolated old-definition-to-migration proofs verify the view and RPC
replacements; the host fixture does not claim their first application during
its later probe upgrade.
The earlier host attempt failed baseline bootstrap because a private runner's
umask made copied SQL files unreadable. Correcting only that private subprocess
umask restored intended source modes, while logs and secret files retained
private modes. The failed attempt remains recorded, and repository code and
health limits were unchanged.

Fresh full application checks passed at the same `8a8472b` revision:
882 passed, six optional checks skipped, typecheck/lint passed and generated
database types matched. The eight-file production browser command passed all
22 relevant cases, including six Upload Workspace cases, with an actual
3.3-second production build (104.8 seconds browser phase; 141.36 seconds total).
Both independent retry-correction review axes reported no hard or optional
findings. The complete 85-case browser pass at `1e8735e` and Next/MCP/React
40-observation proof at `e36ed62` remain earlier history for unchanged UI/Auth
code, not fresh complete browser/Next runs at this revision. Managed services
and the owned database stopped after these checks; no owned listener remained.
See [the final local verification record](qa-v5-verification.md) for exact
commands, revisions, counts, retained failures and remaining checks. Replacement
cloud CI at `1e8735ee4ad9770a3b706445a2ae498b2239f458` passed the previous
four timeout cases, all 85 browser cases and Deployment verification, but failed
one concurrent Upload Batch retry case (881 passed, one failed, six optional
skips; 653.27 seconds). Its browser job passed in 918.2 seconds (build 50.6
seconds), and [Deployment verification 41169488471](https://github.com/Thomisso/iVAT/actions/runs/41169488471)
passed. The narrow conflict-arbiter correction subsequently passed the fresh
integration/full host checks above. At this local evidence capture, the next
replacement cloud run had not started and remained required. See the
[PR checks](https://github.com/Thomisso/iVAT/pull/182/checks) for current status.
Exact-main CI and Deployment verification remain
required; integration evidence does not replace those release gates. The runtime
fixture used disposable credentials and pinned test host keys. A separate
read-only production SSH inventory informed SMTP preparation; it did not prove
production mail delivery. No production writes, mail sends, Release activation,
or monitored production Release were performed while preparing this PR.
