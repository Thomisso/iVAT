#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")/../.."
archive=${1:?Pass the path to a private pilot backup archive}
env_file=${DEPLOY_ENV_FILE:-.env.rosti}
case "$env_file" in .env|.env.rosti) ;; *) echo "Use .env or .env.rosti in the release directory" >&2; exit 1 ;; esac
test -f "$archive"
test ! -e "$env_file" || { echo "Refusing to replace an existing environment file" >&2; exit 1; }
for directory in db db-keys storage; do
  destination="deploy/runtime/$directory"
  if [ -d "$destination" ] && [ -n "$(find "$destination" -mindepth 1 -print -quit)" ]; then
    echo "Refusing to replace non-empty $destination" >&2
    exit 1
  fi
  mkdir -p "$destination"
done
tar -xOf "$archive" backup-config/.env > "$env_file"
export DEPLOY_ENV_FILE="$env_file"
compose() {
  if [ -n "${DEPLOY_COMPOSE_OVERRIDE:-}" ]; then
    docker compose --env-file "$env_file" --profile operator -f docker-compose.rosti.yml -f "$DEPLOY_COMPOSE_OVERRIDE" -f deploy/restore.yml "$@"
  else
    docker compose --env-file "$env_file" --profile operator -f docker-compose.rosti.yml -f deploy/restore.yml "$@"
  fi
}
compose create --no-build db rest storage
compose run --rm -T --no-deps backup --xattrs --xattrs-include='*' --exclude=backup-config -xzf - -C / < "$archive"
echo "Restored into empty directories. Verify image versions and start the Stack for recovery checks before moving DNS."
