# Pilot deployment on Roští

The pilot runs Next.js, the Worker and self-hosted Supabase in one Roští Stack.
The application is at `https://app.ivat.cz`; the public Supabase API is at
`https://api.ivat.cz`. DNS stays at WEDOS with DNSSEC. AI uses the existing
platform-owned provider configurations.

For the actual Stack identity, deployed revisions, DNS/TLS incident, verification
results and backup locations, see the [2026-10-30 deployment record](deployments/2026-10-30-rosti-pilot.md).

This is a pilot exception to ADR-0002's original managed Supabase choice.
Roští manages its hosting infrastructure; we maintain the application images,
Supabase versions, backups and recovery. Medium (4 GB RAM, 25 GB disk) is an
initial trial profile, conditional on measured memory, disk, PID limits and
upload behavior. See [upstream versions and adaptations](../deploy/UPSTREAM.md).

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

Install the official [rosticli](https://rosti.cz/cli) and authenticate with
`rosticli login`; complete the login in the browser. Keep credentials out of
chat. Initialize a target named `rosti`, selecting the existing company and
the Medium trial profile. Keep the prepared Dockerfiles and Compose file.
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

Add `app.ivat.cz` and `api.ivat.cz` in the Stack's Proxy settings. At WEDOS,
create CNAME records `app` and `api`, both pointing to `lb.rosti.cz`, retaining
the existing NSSET and DNSSEC. Disable redirecting all domains to the first
domain: the API and application need separate Host routing. Let Roští issue
HTTPS certificates for both names.

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

Create the operator interactively on the Stack:

```bash
docker compose --env-file .env -f docker-compose.rosti.yml run --rm --no-deps web node deploy/scripts/provision-user.mjs operator@example.com --superadmin
```

This creates or reuses an Auth User and grants SuperAdmin only when the flag
is present. A new User's password is printed once; use a private terminal and
store it securely. Enroll TOTP after signing in. Use the same command without
`--superadmin` for pilot Users; each receives its own Organization through the
existing database trigger. Configure real AI credentials at
`/platform/ai-settings`, assign configurations and processing allowances.

Verify a real uploaded Document reaches review and the expected report/export
can be generated. Verify the full 50 MiB upload through Roští's outer proxy,
including a slow connection. Our proxy permits 51 MiB multipart bodies; it
cannot override the provider's outer limits.

## Release checks and automation

### Prepare a versioned GitHub Release

Merging a pull request into `main` does not update production. When the complete
tested state of `main` is ready to ship, open **Releases → Draft a new release**
in GitHub, choose `main` (or its exact tested commit), create a new version tag
such as `v0.2.0`, and generate the release notes to inspect the included pull
requests. Publish a normal Release; drafts and prereleases do not prepare a
production deployment. Do not move or reuse a published version tag.

The **Release Roští pilot** workflow first resolves the tag to its exact
commit, including annotated tags, and checks that it belongs to `main`. It
waits up to 35 minutes for successful **CI** and **Deployment verification**
runs produced by a push of that exact commit to `main`. A successful test of a
different commit or a pull-request merge is insufficient. Failed checks stop
preparation; unfinished or missing checks time out with an explanation.

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
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3102 npx playwright test e2e/release-identity.spec.ts
```

For an explicitly versioned test build, also set `TEST_RELEASE_TAG` and
`TEST_RELEASE_REVISION` for the browser test's expected identity. Those variables
only configure test expectations; the application never reads them. The export
regression loads two independently prepared source installations against one
isolated database and checks original draft/final bytes and hashes after the
software change, for both XML formats.

During the separate activation review, configure repository variables
`ROSTI_PUBLIC_SUPABASE_URL` and `ROSTI_PUBLIC_SUPABASE_KEY` with the existing
production public API URL and publishable/anon key. These are public build
settings. Never enter a service-role key, database password or JWT signing
secret there. The workflow refuses private service keys before building.

Open the successful workflow run and download its `rosti-release-…` artifact
to inspect the bundle. It contains a manifest with the revision, version,
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

If preparation fails, read the failed step, correct the reported CI or public
configuration problem, and re-run the failed jobs. Each new build attempt
retains its own image tags and artifact, so an existing release's content is
not silently replaced.

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
   host Bash, `flock`, `setsid`, GNU `timeout`, Docker Compose and free disk space.
   Read the running database container's `com.docker.compose.project` label
   privately and retain that exact project name. Do not guess a new project.
2. Verify the SSH endpoint and host key fingerprint against a trusted provider
   channel or an already independently verified connection. Prepare the pinned
   OpenSSH `known_hosts` entry, including `[host]:port` for a nonstandard port.
   An unchecked `ssh-keyscan` result is not host verification.
3. Create reviewed SSH access and a Roští API key limited as the provider allows
   to the existing Stack/company. Keep private `.env` and Vault values on the
   Stack. The workflow never downloads or replaces them.
4. Verify the existing daily cron and cron daemon, the newest completed daily
   `.tar.gz` plus matching `.images.json`, age at most 26 hours, gzip integrity,
   and seven-day retention. Confirm previous revision/image records are present
   and there is no unresolved deployment. No extra release backup, computer
   copy or external destination is required.
5. In GitHub **Settings → Secrets and variables → Actions**, configure the
   following repository settings. This setup uses repository settings and does
   not require a paid GitHub environment feature.

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

Finally, after the explicit activation review, set `ROSTI_DEPLOY_ENABLED` to
`true` and publish one monitored stable Release. Watch its Actions run and
verify public HTTPS, a real login and a representative Document workflow.
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
The launcher has a 45-minute host deadline including lock wait. Its termination
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

The existing schedule is:

```cron
15 3 * * * flock -n /tmp/ivat-backup.lock sh /srv/stack/deploy/scripts/backup-daily.sh >> /srv/stack/deploy/backups/daily.log 2>&1
```

The pilot host timezone was UTC, so this is 03:15 UTC. During activation,
recheck the installed cron and running daemon, especially after replacing the
provider's `mgm` container. Inspect `daily.log` privately for failures. No new
schedule, retention policy or automatic external alert is installed by this
release workflow. Historical computer copies in the deployment record do
not create a requirement for future releases.

For an independently requested manual backup, use the same lock; releases do
not require this extra step:

```bash
flock -w 900 /tmp/ivat-backup.lock env DEPLOY_ENV_FILE=.env sh deploy/scripts/backup.sh /srv/stack/deploy/backups
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

The command acquires the same `/tmp/ivat-backup.lock` used by the daily cron
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
injection still uses disposable-only overrides. The new fast source-preparation
check passed during #162. After stopping the ticket stacks, earlier pre-fix
integration verification for #179 ran
`IVAT_RELEASE_RUNTIME_TEST=1 node --test deploy/tests/release-runtime.test.mjs`
at `80ace776d9325550214c1ac5e447532ba80b8807` on Docker Desktop for macOS:
all three tests passed, with zero skips, in 190 seconds. This includes the
compiled release tag and full revision, interrupted-observer recovery, and
failed-migration recovery guard. See [the final local verification record](qa-v5-verification.md)
for the application and browser history, earlier failures, and remaining checks.
Existing CI and Deployment verification remain required for the exact `main`
revision; integration checks do not replace those release gates. The runtime
fixture used disposable credentials and pinned test host keys. A separate
read-only production SSH inventory informed SMTP preparation; it did not prove
production mail delivery. No production writes, mail sends, Release activation,
or monitored production Release were performed while preparing this PR.
