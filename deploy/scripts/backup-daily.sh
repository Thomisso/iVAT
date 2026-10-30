#!/bin/sh
# Run through flock on the Stack host. Keep seven days of successful snapshots.
set -eu
umask 077
cd "$(dirname "$0")/../.."
export DEPLOY_ENV_FILE=.env
sh deploy/scripts/backup.sh /srv/stack/deploy/backups
# Only expire this script's archives after a new backup has succeeded.
find deploy/backups -maxdepth 1 -type f \( -name 'ivat-*.tar.gz' -o -name 'ivat-*.tar.gz.images.json' \) -mtime +6 -delete
