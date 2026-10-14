#!/bin/sh
# PostgreSQL backups for the attendance database.
#
# Runs inside the "backup" compose service (postgres image, so pg_dump
# matches the server version). By default it loops forever: one dump right
# away, then one every BACKUP_INTERVAL_SECONDS. With --once it takes a
# single dump and exits:
#
#     docker compose exec backup sh /usr/local/bin/backup.sh --once
#
# Dumps are pg_dump custom format (-Fc, already compressed), written to a
# temp name, verified with pg_restore --list, then renamed, so a half-written
# file never looks like a good backup. Only the newest BACKUP_KEEP dumps are
# kept. Restore with deploy/restore.sh.
#
# Remember: face data in the database is encrypted with FACE_DATA_KEY.
# These dumps are useless for biometrics without that key - back the key up
# separately (password manager / sealed envelope), never next to the dumps.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
export PGHOST="${PGHOST:-db}"
export PGUSER="${PGUSER:-attendance}"
export PGDATABASE="${PGDATABASE:-attendance}"
export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"

umask 077
mkdir -p "$BACKUP_DIR"

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') backup: $*"; }

wait_for_db() {
	i=0
	until pg_isready -q; do
		i=$((i + 1))
		if [ "$i" -ge 60 ]; then
			log "database not reachable at $PGHOST after 120s"
			return 1
		fi
		sleep 2
	done
}

prune() {
	# Newest first; drop everything after the first BACKUP_KEEP.
	# shellcheck disable=SC2012
	ls -1t "$BACKUP_DIR"/"$PGDATABASE"-*.dump 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
		rm -f -- "$old"
		log "pruned $old"
	done
}

backup_once() {
	wait_for_db || return 1
	stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
	final="$BACKUP_DIR/$PGDATABASE-$stamp.dump"
	tmp="$final.partial"
	if ! pg_dump --format=custom --compress=6 --no-owner --file="$tmp"; then
		rm -f -- "$tmp"
		log "pg_dump FAILED"
		return 1
	fi
	if ! pg_restore --list "$tmp" >/dev/null; then
		rm -f -- "$tmp"
		log "dump verification FAILED"
		return 1
	fi
	mv -- "$tmp" "$final"
	log "wrote $final ($(du -h "$final" | cut -f1))"
	prune
}

if [ "${1:-}" = "--once" ]; then
	backup_once
	exit $?
fi

log "every ${BACKUP_INTERVAL_SECONDS}s into $BACKUP_DIR, keeping $BACKUP_KEEP"
while true; do
	# A failed run is logged and retried next cycle; it doesn't kill the loop.
	backup_once || log "will retry in ${BACKUP_INTERVAL_SECONDS}s"
	sleep "$BACKUP_INTERVAL_SECONDS" &
	# wait (not plain sleep) so `docker compose stop` ends the loop at once.
	wait $!
done
