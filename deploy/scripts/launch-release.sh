#!/usr/bin/env bash
# Host-owned lifecycle. SSH only launches/polls it; never holds the backup lock.
set -Eeuo pipefail
umask 077
operation=${1:?Pass start, run or status}
stack=$(cd "${2:?Pass existing stack}" && pwd -P)
bundle=$(cd "${3:?Pass bundle}" && pwd -P)
project=${4:?Pass project}
id=${5:?Pass attempt ID}
actor=${6:?Pass registry actor}
[[ $id =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$ && $project =~ ^[a-z0-9][a-z0-9_-]*$ && $actor =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || { echo 'Invalid deployment launch identity.' >&2; exit 1; }
transport=$stack/deploy/transports/$id
case $operation in
  start)
    command -v timeout >/dev/null
    command -v setsid >/dev/null
    mkdir -p "$stack/deploy/transports"
    mkdir "$transport" # No retry may overwrite the outcome of an existing ID.
    printf 'running\n' > "$transport/result"
    trap 'rm -f "$transport/credentials"; printf "failed\n" > "$transport/result"' EXIT
    IFS= read -r registry
    IFS= read -r provider
    [[ -n $registry && -n $provider ]] || exit 1
    printf '%s\n%s\n' "$registry" "$provider" > "$transport/credentials"
    # Open in the synchronous parent before unlinking; a background redirection
    # can otherwise race rm and leave a permanently "running" transport.
    exec 3< "$transport/credentials"
    rm "$transport/credentials"
    nohup setsid bash "$bundle/deploy/scripts/launch-release.sh" run "$stack" "$bundle" "$project" "$id" "$actor" <&3 3<&- > "$transport/host.log" 2>&1 &
    exec 3<&-
    trap - EXIT
    printf 'launched\n'
    ;;
  run)
    finish() {
      code=$?
      trap - EXIT
      if [[ $code == 0 && -f $stack/deploy/attempts/$id/result && $(cat "$stack/deploy/attempts/$id/result") == success ]]; then
        printf 'success\n' > "$transport/result.next"
      else
        printf 'failed\n' > "$transport/result.next"
      fi
      mv "$transport/result.next" "$transport/result"
    }
    trap finish EXIT
    export GHCR_USER=$actor IVAT_DEPLOY_CREDENTIALS_STDIN=1 IVAT_DEPLOY_ATTEMPT_ID=$id
    # TERM invokes deploy-release's migration cleanup. Deliberately no KILL:
    # uncertain Docker state must retain the lock/marker for joint recovery.
    timeout --signal=TERM 2700 bash "$bundle/deploy/scripts/deploy-release.sh" "$stack" "$bundle" "$project"
    ;;
  status)
    [[ -f $transport/result ]] || { echo 'unknown'; exit 0; }
    cat "$transport/result"
    if [[ -f $stack/deploy/attempts/$id/phase ]]; then cat "$stack/deploy/attempts/$id/phase"; else printf 'preflight\n'; fi
    if [[ -f $stack/deploy/attempts/$id/result && $(cat "$stack/deploy/attempts/$id/result") == needs-intervention ]]; then printf 'needs-intervention\n'; fi
    ;;
  *) echo 'Invalid launcher operation.' >&2; exit 1 ;;
esac
