#!/bin/sh
# Cold, consistent pilot backup. Run on the Stack host with Docker access.
set -eu
umask 077
cd "$(dirname "$0")/../.."
if [ -e deploy/.deployment-unresolved ]; then
  echo "Backup refused: unresolved deployment; inspect its attempt before joint recovery." >&2
  exit 1
fi
env_file=${DEPLOY_ENV_FILE:-.env.rosti}
export DEPLOY_ENV_FILE="$env_file"
destination=${1:?Pass a private destination directory outside deploy/runtime}
mkdir -p "$destination"
destination=$(cd "$destination" && pwd)
archive="$destination/ivat-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
compose() {
  if [ -n "${DEPLOY_COMPOSE_OVERRIDE:-}" ]; then
    docker compose --env-file "$env_file" --profile operator -f docker-compose.rosti.yml -f "$DEPLOY_COMPOSE_OVERRIDE" "$@"
  else
    docker compose --env-file "$env_file" --profile operator -f docker-compose.rosti.yml "$@"
  fi
}
test -f "$env_file"
test -d deploy/runtime/db
test -d deploy/runtime/db-keys
test -d deploy/runtime/storage
# Record the image IDs before stopping, for matching restore/rollback versions.
compose images --format json > "$archive.images.json"
trap 'compose up -d --no-build web worker proxy >/dev/null' EXIT
trap 'exit 130' HUP INT TERM
compose stop
# GNU tar runs inside Linux, preserving Storage metadata in extended attributes.
# volumes_from also makes this work with the macOS test-only named volume.
compose run --rm -T --no-deps backup --xattrs --xattrs-include='*' -czf - /var/lib/postgresql/data /etc/postgresql-custom /var/lib/storage /backup-config > "$archive.partial"
mv "$archive.partial" "$archive"
echo "Backup created: $archive"
echo "Contains database keys and credentials. Keep this archive private."
