#!/bin/sh
# MySQL backups for the attendance database.
#
# Runs inside the "backup" compose service (mysql image, so mysqldump
# matches the server version). By default it loops forever: one dump right
# away, then one every BACKUP_INTERVAL_SECONDS. With --once it takes a
# single dump and exits:
#
#     docker compose exec backup sh /usr/local/bin/backup.sh --once
#
# Dumps are gzip-compressed SQL made with --single-transaction (a consistent
# snapshot while the kiosks keep punching, no table locks) and --hex-blob
# (photos and scan snapshots are binary). Each is written to a temp name,
# verified (gzip integrity plus mysqldump's "Dump completed" trailer), then
# renamed, so a half-written file never looks like a good backup. Only the
# newest BACKUP_KEEP dumps are kept. Restore with deploy/restore.sh.
#
# Remember: face data in the database is encrypted with FACE_DATA_KEY.
# These dumps are useless for biometrics without that key - back the key up
# separately (password manager / sealed envelope), never next to the dumps.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
MYSQL_HOST="${MYSQL_HOST:-db}"
MYSQL_USER="${MYSQL_USER:-attendance}"
MYSQL_DATABASE="${MYSQL_DATABASE:-attendance}"

umask 077
mkdir -p "$BACKUP_DIR"

# The password goes in a private options file, not on the command line (visible in `ps`).
CNF="$(mktemp)"
trap 'rm -f "$CNF"' EXIT
{
	echo "[client]"
	echo "host=$MYSQL_HOST"
	echo "user=$MYSQL_USER"
	echo "password=${MYSQL_PASSWORD:-}"
} > "$CNF"

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') backup: $*"; }

wait_for_db() {
	i=0
	until mysqladmin --defaults-extra-file="$CNF" ping --silent >/dev/null 2>&1; do
		i=$((i + 1))
		if [ "$i" -ge 60 ]; then
			log "database not reachable at $MYSQL_HOST after 120s"
			return 1
		fi
		sleep 2
	done
}

prune() {
	# Newest first; drop everything after the first BACKUP_KEEP.
	# shellcheck disable=SC2012
	ls -1t "$BACKUP_DIR"/"$MYSQL_DATABASE"-*.sql.gz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
		rm -f -- "$old"
		log "pruned $old"
	done
}

dump() {
	# pipefail is not in POSIX sh, so mysqldump's own status is carried out through a file.
	status="$(mktemp)"
	{ mysqldump --defaults-extra-file="$CNF" --single-transaction --routines --triggers --events \
		--hex-blob --default-character-set=utf8mb4 --set-gtid-purged=OFF --no-tablespaces \
		"$MYSQL_DATABASE" 2>"$status.err"; echo $? >"$status"; } | gzip -6 > "$1"
	code="$(cat "$status")"
	[ "$code" = "0" ] || cat "$status.err" >&2
	rm -f -- "$status" "$status.err"
	return "$code"
}

backup_once() {
	wait_for_db || return 1
	stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
	final="$BACKUP_DIR/$MYSQL_DATABASE-$stamp.sql.gz"
	tmp="$final.partial"
	if ! dump "$tmp"; then
		rm -f -- "$tmp"
		log "mysqldump FAILED"
		return 1
	fi
	if ! gzip -t "$tmp" || ! gzip -dc "$tmp" | tail -n 5 | grep -q "Dump completed"; then
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
