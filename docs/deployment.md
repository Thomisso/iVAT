# Pilot deployment on Roští

The pilot runs Next.js, the Worker and self-hosted Supabase in one Roští Stack.
The application is at `https://app.ivat.cz`; the public Supabase API is at
`https://api.ivat.cz`. DNS stays at WEDOS with DNSSEC. AI uses the existing
platform-owned provider configurations.

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
The API hostname is part of the application build; a temporary hostname must
be configured before building if it is used instead.

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

The deployment verification workflow boots the self-hosted services and
reuses Application integration tests, in addition to the existing CI checks.
Its local counterpart is:

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

Restore into an empty, separate Stack using the same PostgreSQL and service
versions and a checkout of this release:

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
