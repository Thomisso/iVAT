#!/bin/sh
# Source from the caller so descriptor 9 remains open through its cleanup.
# Both BusyBox and util-linux support nonblocking descriptor locks.
acquire_backup_lock() {
  case ${2-} in ''|*[!0-9]*) return 2 ;; esac
  [ "$2" -ge 1 ] && [ "$2" -le 3600 ] || return 2
  exec 9>"$1" || return 1
  ivat_lock_attempt=0
  until flock -n 9; do
    [ "$ivat_lock_attempt" -lt "$2" ] || return 1
    ivat_lock_attempt=$((ivat_lock_attempt + 1))
    sleep 1
  done
}
