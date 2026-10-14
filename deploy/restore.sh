#!/usr/bin/env bash
# Restore the attendance database from a dump made by deploy/backup.sh.
#
#     deploy/restore.sh backups/attendance-20261014T020000Z.dump
#
# Run from the repo root on the Docker host (Linux shell, or Git Bash on
# Windows). It REPLACES the current database contents:
#   1. takes a safety dump of the current database into the backup folder,
#   2. stops the backend (so kiosks can't write mid-restore),
#   3. restores in a single transaction (all or nothing),
#   4. starts the backend again (pending migrations run automatically).
#
# The restored face data only decrypts with the FACE_DATA_KEY that was in
# use when the dump was taken - restore backend/.env from your key backup
# first if this is a new machine.
set -euo pipefail

DUMP="${1:-}"
if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
	echo "usage: $0 <path/to/attendance-YYYYMMDDTHHMMSSZ.dump>" >&2
	exit 2
fi

DB_USER="${PGUSER:-attendance}"
DB_NAME="${PGDATABASE:-attendance}"
COMPOSE=(docker compose)

echo "About to REPLACE database '$DB_NAME' with: $DUMP"
if [[ "${FORCE:-}" != "1" ]]; then
	read -r -p "Type 'restore' to continue: " answer
	[[ "$answer" == "restore" ]] || { echo "aborted"; exit 1; }
fi

"${COMPOSE[@]}" up -d db
until "${COMPOSE[@]}" exec -T db pg_isready -q -U "$DB_USER" -d "$DB_NAME"; do sleep 2; done

# Work from a private copy: the safety dump below prunes old backups, which
# could otherwise delete the very file being restored.
WORK="$(mktemp)"
trap 'rm -f "$WORK"' EXIT
cp -- "$DUMP" "$WORK"

echo "Checking the dump is readable..."
"${COMPOSE[@]}" exec -T db pg_restore --list < "$WORK" > /dev/null

echo "Taking a safety dump of the current database..."
if "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx backup; then
	"${COMPOSE[@]}" exec -T backup sh /usr/local/bin/backup.sh --once
else
	echo "  (backup service not running; skipping - make sure you have a copy)"
fi

echo "Stopping the backend..."
"${COMPOSE[@]}" stop backend

echo "Restoring..."
"${COMPOSE[@]}" exec -T db pg_restore \
	--username="$DB_USER" --dbname="$DB_NAME" \
	--clean --if-exists --no-owner --single-transaction --exit-on-error \
	< "$WORK"

echo "Starting the backend (migrations run on start)..."
"${COMPOSE[@]}" start backend
echo "Done. Check: ${COMPOSE[*]} ps && ${COMPOSE[*]} logs --tail=50 backend"
