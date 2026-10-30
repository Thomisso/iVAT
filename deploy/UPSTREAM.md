# Supabase deployment sources

The pilot adapts the official Supabase Docker distribution at
`self-hosted/v0.8.3`, commit `bc27d2661edd09a5d0b8d76ce33da6d4071a756e`.
Source: https://github.com/supabase/supabase/tree/self-hosted/v0.8.3/docker

`db/roles.sql`, `db/jwt.sql`, `db/webhooks.sql` and
`gateway/kong-entrypoint.sh` are copied unchanged. `gateway/kong.yml` retains
only Auth, REST and Storage routes and legacy JWT API keys. The Apache 2.0
license is retained in `SUPABASE-LICENSE`.

The database bind mount must retain both PostgreSQL data and the entire
`/etc/postgresql-custom` directory, including encryption keys. `db/entrypoint.sh`
initializes empty bind mounts with the image's defaults without replacing
existing files. The webhooks initialization file creates a role required by
`roles.sql`; removing it causes database initialization to stop before the
Auth ownership migrations run.

The pilot omits Studio, Realtime, Edge Functions, Analytics, the connection
pooler and image transformations. Database and file storage are operated by
the application owner. This is the agreed pilot exception to ADR-0002's
original managed-hosting choice.
