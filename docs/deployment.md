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

The **Prepare Roští release** workflow first resolves the tag to its exact
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

Preparation alone does not contact or change the live Stack. Publishing
images and artifacts does not mean a version has been deployed. Production
activation and the subsequent deployment result are separate steps.

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

After the first verified deployment, `rosticli stacks setup-cicd --target rosti`
can bind GitHub Actions and the registry to this Stack. Review the generated
workflow: deploy only trusted commits after CI and deployment verification
succeed, retain images tagged by commit SHA, and serialize deployments. Do not
deploy directly from an untrusted pull request. Provider binding, SMTP and the
off-server backup destination are deployment-specific configuration.

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

Before each later release, create and retain a backup and record the current
image IDs. Tag built images by revision before replacing `latest`, and update
`deploy/release-commit.txt` and `deploy/release-images.txt` after verification.
For an application rollback with a compatible database schema, restore the
retained app/proxy image tags to the names referenced by Compose, then run:

```bash
docker compose --env-file .env -f docker-compose.rosti.yml up -d --no-build --no-deps --wait web worker proxy
```

This does not undo migrations. A database rollback requires a separate restore
decision and the matching database version and encryption keys.

## Backups and recovery

The pilot uses a cold backup, with a short maintenance window. Run this on the
Stack host, in the directory containing its Compose file:

```bash
DEPLOY_ENV_FILE=.env sh deploy/scripts/backup.sh /srv/stack/deploy/backups
```

The backup container uses GNU tar in Linux with extended attributes enabled.
It captures PostgreSQL data, database encryption keys, Storage files and their
metadata, the environment file and Compose configuration. Services are stopped
for a consistent snapshot and restarted afterwards. The archive and companion
image inventory are private; copy them to encrypted storage outside this Stack.
Set up a daily schedule and alert on failures when the host is connected. Local
archives or provider snapshots alone do not protect against losing the Stack.

For the initial pilot, `backup-daily.sh` keeps seven days of successful local
snapshots. Install it in the host crontab, preserving existing entries:

```cron
15 3 * * * flock -n /tmp/ivat-backup.lock sh /srv/stack/deploy/scripts/backup-daily.sh >> /srv/stack/deploy/backups/daily.log 2>&1
```

The time follows the host timezone. This is a cold backup with a brief daily
outage. Check `daily.log`; automatic failure alerts and automatic off-server
copies still require an external destination/monitor. Keep at least a verified
initial backup outside the Stack before onboarding pilot Users.

The pilot host timezone was verified as UTC, so the installed schedule is
03:15 UTC. Recheck the crontab and running cron service after replacement or
recreation of the provider's `mgm` container. The current off-server copies
are manual copies to the operator's computer; no recurring off-server transfer
or automatic failure notification was configured during the first rollout.

Copy both the printed archive and its `.images.json` companion privately via
SSH. For example, from the connected local checkout (replace the archive name
with the one just created):

```bash
umask 077
archive=ivat-20261030T155043Z.tar.gz
private_backup_dir="$HOME/.config/ivat/production"
mkdir -p "$private_backup_dir"
chmod 700 "$private_backup_dir"
rosticli stacks ssh --target rosti -- sh -lc "cat /srv/stack/deploy/backups/$archive" > "$private_backup_dir/$archive"
rosticli stacks ssh --target rosti -- sh -lc "cat /srv/stack/deploy/backups/$archive.images.json" > "$private_backup_dir/$archive.images.json"
gzip -t "$private_backup_dir/$archive"
```

These archives include the environment file and database encryption keys.
File permissions protect the current local copies; the archive format itself
does not encrypt them. Preserve the matching service images separately: the
image inventory records their IDs but does not contain the images.

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
profile limit, including Docker images and local backup retention. Do not run
automatic pruning until the rollback image and independent backup are retained.
