#!/bin/sh
set -eu
# A bind mount starts empty, unlike a named Docker volume. Preserve the image's
# required defaults and any existing encryption key; never overwrite live files.
cp -an /opt/ivat-postgresql-defaults/* /etc/postgresql-custom/
chown -R postgres:postgres /etc/postgresql-custom
exec docker-entrypoint.sh "$@"
