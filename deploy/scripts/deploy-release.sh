#!/usr/bin/env bash
# Run on the Stack host, never through its interactive fish login shell.
set -Eeuo pipefail
umask 077
stack=$(cd "${1:?Pass the existing Stack directory}" && pwd -P)
bundle=$(cd "${2:?Pass the extracted release bundle}" && pwd -P)
project=${3:?Pass the existing Compose project name}
[[ $project =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo 'Invalid Compose project name.' >&2; exit 1; }
[[ -f $stack/.env && -f $stack/docker-compose.rosti.yml ]] || { echo 'Existing installation and environment are required.' >&2; exit 1; }
[[ ! -e $stack/deploy/.deployment-unresolved ]] || { echo 'An unresolved deployment blocks releases and backups; inspect its attempt before joint recovery.' >&2; exit 1; }
lock=${IVAT_DEPLOY_LOCK_FILE:-/tmp/ivat-backup.lock}
lock_wait=${IVAT_DEPLOY_LOCK_TIMEOUT:-900}
[[ $lock_wait =~ ^[0-9]+$ && $lock_wait -ge 1 && $lock_wait -le 3600 ]] || { echo 'Invalid deployment lock timeout.' >&2; exit 1; }
disposable=0
override=${IVAT_DISPOSABLE_COMPOSE_OVERRIDE:-}
if [[ -n $override || -n ${IVAT_DEPLOY_TEST_APP_IMAGE:-} || -n ${IVAT_DEPLOY_PUBLIC_URL:-} || $lock != /tmp/ivat-backup.lock ]]; then
  [[ $stack != /srv/stack && -f $stack/.ivat-disposable-deployment && -f $override && $override == "$stack/"* ]] || { echo 'Disposable overrides are forbidden for production.' >&2; exit 1; }
  disposable=1
fi
exec 9>"$lock"
flock -w "$lock_wait" 9 || { echo 'Deployment lock unavailable; a backup or release is still running.' >&2; exit 1; }
# Check again while holding the same lock as cron.
[[ ! -e $stack/deploy/.deployment-unresolved ]] || { echo 'An unresolved deployment requires joint recovery.' >&2; exit 1; }
if [[ ${IVAT_DEPLOY_CREDENTIALS_STDIN:-0} == 1 ]]; then
  IFS= read -r GHCR_TOKEN
  IFS= read -r ROSTI_API_KEY
  export GHCR_TOKEN ROSTI_API_KEY
fi
temporary=$(mktemp -d)
export DOCKER_CONFIG=$temporary/registry
mkdir "$DOCKER_CONFIG"
attempt=''
phase=preflight
migrating=0
compose_args=(compose --project-directory "$stack" --project-name "$project" --env-file "$stack/.env" -f "$stack/docker-compose.rosti.yml")
[[ -z $override ]] || compose_args+=(-f "$override")
compose() { docker "${compose_args[@]}" "$@"; }
cleanup() {
  code=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [[ $migrating == 1 ]]; then
    # Killing the CLI alone can leave the daemon's migration container writing.
    # Keep the lock and unresolved marker until its state is confirmed stopped.
    while true; do
      timeout 40 docker "${compose_args[@]}" stop -t 10 migrate >/dev/null 2>&1 || true
      id=$(timeout 15 docker "${compose_args[@]}" ps -aq migrate 2>/dev/null) || id=unknown
      if [[ -z $id ]]; then break; fi
      running=$(timeout 15 docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null) || running=unknown
      [[ $running != false ]] || break
      [[ $id == unknown ]] || timeout 15 docker kill "$id" >/dev/null 2>&1 || true
      [[ -z $attempt ]] || printf 'needs-intervention\n' > "$attempt/result"
      echo 'Migration state is uncertain; retaining deployment lock for operator intervention.' >&2
      sleep 5
    done
  fi
  if [[ -n $attempt && $code != 0 ]]; then
    printf 'failed\n' > "$attempt/result"
    echo "Deployment failed at $phase. Inspect $attempt; recovery is operator-controlled." >&2
  fi
  rm -rf "$temporary"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
if [[ $disposable == 1 ]]; then
  helper_image=${IVAT_DEPLOY_TEST_APP_IMAGE:?Disposable helper image required}
else
  helper_image=$(sed -nE 's/^[[:space:]]*"app": "(ghcr\.io\/thomisso\/ivat\/app@sha256:[a-f0-9]{64})",?$/\1/p' "$bundle/manifest.json")
  [[ $helper_image =~ ^ghcr\.io/thomisso/ivat/app@sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid release helper image.' >&2; exit 1; }
  [[ -n ${GHCR_USER:-} && -n ${GHCR_TOKEN:-} ]] || { echo 'Registry credentials are required.' >&2; exit 1; }
  printf '%s' "$GHCR_TOKEN" | timeout 60 docker login ghcr.io --username "$GHCR_USER" --password-stdin >/dev/null
  timeout 300 docker pull "$helper_image" >/dev/null
fi
helper() {
  network=$1; shift
  extra=()
  [[ $disposable != 1 || $network == none ]] || extra+=(--add-host host.docker.internal:host-gateway)
  timeout 180 docker run --rm --user 0:0 --network "$network" "${extra[@]}" --entrypoint node \
    -v "$bundle:/release:ro" -v "$stack:/stack" \
    --env ROSTI_API_KEY --env ROSTI_API_URL --env ROSTI_TIMEOUT_MS \
    --env IVAT_DEPLOY_PUBLIC_URL --env IVAT_DISPOSABLE_DEPLOYMENT="$disposable" \
    "$helper_image" /release/deploy/scripts/release-host.mjs "$@"
}
helper none preflight /release /stack > "$temporary/metadata"
revision=$(sed -n '1p' "$temporary/metadata")
[[ $revision =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid verified release identity.' >&2; exit 1; }
# Ensure the supplied project identifies the existing installation.
[[ -n $(compose ps -aq db) ]] || { echo 'Existing database not found in the selected Compose project.' >&2; exit 1; }
docker compose --project-directory "$stack" --project-name "$project" --env-file "$stack/.env" -f "$bundle/docker-compose.rosti.yml" config --quiet
if [[ $disposable != 1 ]]; then
  [[ $helper_image == "$(sed -n '2p' "$temporary/metadata")" ]] || { echo 'Helper image does not match verified release.' >&2; exit 1; }
  for line in 2 3 4 5; do timeout 300 docker pull "$(sed -n "${line}p" "$temporary/metadata")" >/dev/null; done
fi
mkdir -p "$stack/deploy/attempts"
if [[ -n ${IVAT_DEPLOY_ATTEMPT_ID:-} ]]; then
  [[ $IVAT_DEPLOY_ATTEMPT_ID =~ ^[a-zA-Z0-9._-]{1,100}$ ]] || { echo 'Invalid deployment attempt ID.' >&2; exit 1; }
  attempt=$stack/deploy/attempts/$IVAT_DEPLOY_ATTEMPT_ID
  mkdir "$attempt"
else
  attempt=$(mktemp -d "$stack/deploy/attempts/$revision.XXXXXX")
fi
relative=${attempt#"$stack/"}
printf 'running\n' > "$attempt/result"
echo "Attempt: $relative"
set_phase() { phase=$1; printf '%s\n' "$phase" > "$attempt/phase"; }
set_phase retain
cp "$stack/docker-compose.rosti.yml" "$attempt/docker-compose-before.yml"
for name in docker-compose.yml; do [[ ! -f $stack/$name ]] || cp "$stack/$name" "$attempt/$name"; done
for name in verified-release.json release-commit.txt release-images.txt; do [[ ! -f $stack/deploy/$name ]] || cp "$stack/deploy/$name" "$attempt/$name"; done
compose images --format json > "$attempt/images-before.json"
index=0
while IFS= read -r id; do
  [[ -n $id ]] || continue
  index=$((index + 1))
  tag=ivat-retained:$(basename "$attempt")-$index
  docker image tag "$id" "$tag"
  printf '%s %s\n' "$id" "$tag" >> "$attempt/retained-images.txt"
done < <(compose images -q | sort -u)
# Install the backup guard before any provider/configuration mutation.
cp "$bundle/deploy/scripts/backup.sh" "$stack/deploy/scripts/backup.sh"
printf '%s\n' "$relative" > "$stack/deploy/.deployment-unresolved"
set_phase provider-sync
helper bridge sync /release /stack "$relative"
set_phase stop-application
old=(compose --project-directory "$stack" --project-name "$project" --env-file "$stack/.env" -f "$attempt/docker-compose-before.yml")
[[ -z $override ]] || old+=(-f "$override")
timeout 180 docker "${old[@]}" stop proxy web worker > "$attempt/stop.log" 2>&1
set_phase configuration
cp "$bundle/docker-compose.rosti.yml" "$stack/docker-compose.rosti.yml"
cp "$bundle/docker-compose.rosti.yml" "$stack/docker-compose.yml"
cp "$bundle"/deploy/scripts/* "$stack/deploy/scripts/"
cp "$bundle/deploy/restore.yml" "$stack/deploy/restore.yml"
set_phase core-services
compose up -d --no-build --wait --wait-timeout 240 db auth rest storage gateway > "$attempt/core.log" 2>&1
set_phase migration
migrating=1
timeout 600 docker "${compose_args[@]}" up --no-build --no-deps --force-recreate --abort-on-container-exit --exit-code-from migrate migrate > "$attempt/migration.log" 2>&1
migrating=0
set_phase application
compose up -d --no-build --no-deps --wait --wait-timeout 240 web worker proxy > "$attempt/application.log" 2>&1
set_phase verification
helper bridge probe /release /stack
# Compare actual container image identities with the selected Compose images.
compose config --format json > "$temporary/effective-compose.json"
while IFS=' ' read -r service image; do
  id=$(compose ps -q "$service")
  [[ -n $id && $(docker inspect --format '{{.Image}}' "$id") == "$(docker image inspect --format '{{.Id}}' "$image")" ]] || { echo "Selected image verification failed: $service." >&2; exit 1; }
done < <(docker run --rm -i --network none --entrypoint node "$helper_image" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const c=JSON.parse(s);for(const n of ["web","worker","db","gateway","proxy"])console.log(n+" "+c.services[n].image)})' < "$temporary/effective-compose.json")
compose images --format json > "$attempt/images-after.json"
helper none record /release /stack "$relative"
rm "$stack/deploy/.deployment-unresolved"
set_phase verified
printf 'success\n' > "$attempt/result"
echo "Verified deployment: $revision."
