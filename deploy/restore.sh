#!/usr/bin/env bash
# Restore the attendance database from a dump made by deploy/backup.sh.
#
#     deploy/restore.sh backups/attendance-20261014T020000Z.sql.gz
#
# Run from the repo root on the Docker host (Linux shell, or Git Bash on
# Windows). It REPLACES the current database contents:
#   1. takes a safety dump of the current database into the backup folder,
#   2. stops the backend (so kiosks can't write mid-restore),
#   3. drops and recreates the schema, then loads the dump,
#   4. starts the backend again (pending migrations run automatically).
#
# Unlike PostgreSQL, MySQL cannot roll back schema changes, so the restore is
# NOT all-or-nothing. If it fails part-way, the safety dump from step 1 (the
# newest file in the backup folder) is the way back: run this script again
# with that file.
#
# The restored face data only decrypts with the FACE_DATA_KEY that was in
# use when the dump was taken - restore backend/.env from your key backup
# first if this is a new machine.
set -euo pipefail

DUMP="${1:-}"
if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
	echo "usage: $0 <path/to/attendance-YYYYMMDDTHHMMSSZ.sql.gz>" >&2
	exit 2
fi

DB_NAME="${MYSQL_DATABASE:-attendance}"
COMPOSE=(docker compose)
# Runs inside the db container, where the root password is already in the environment.
MYSQL_ROOT='mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4'

echo "About to REPLACE database '$DB_NAME' with: $DUMP"
if [[ "${FORCE:-}" != "1" ]]; then
	read -r -p "Type 'restore' to continue: " answer
	[[ "$answer" == "restore" ]] || { echo "aborted"; exit 1; }
fi

"${COMPOSE[@]}" up -d db
until "${COMPOSE[@]}" exec -T db sh -c 'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent' >/dev/null 2>&1; do sleep 2; done

# Work from a private copy: the safety dump below prunes old backups, which
# could otherwise delete the very file being restored.
WORK="$(mktemp)"
trap 'rm -f "$WORK"' EXIT
cp -- "$DUMP" "$WORK"

echo "Checking the dump is readable..."
gzip -t "$WORK"
gzip -dc "$WORK" | tail -n 5 | grep -q "Dump completed" || { echo "dump is incomplete (no 'Dump completed' trailer)" >&2; exit 1; }

echo "Taking a safety dump of the current database..."
if "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx backup; then
	"${COMPOSE[@]}" exec -T backup sh /usr/local/bin/backup.sh --once
else
	echo "  (backup service not running; skipping - make sure you have a copy)"
fi

echo "Stopping the backend..."
"${COMPOSE[@]}" stop backend

echo "Restoring..."
"${COMPOSE[@]}" exec -T db sh -c "$MYSQL_ROOT -e 'DROP DATABASE IF EXISTS \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;'"
gzip -dc "$WORK" | "${COMPOSE[@]}" exec -T db sh -c "$MYSQL_ROOT \"$DB_NAME\""

echo "Starting the backend (migrations run on start)..."
"${COMPOSE[@]}" start backend
echo "Done. Check: ${COMPOSE[*]} ps && ${COMPOSE[*]} logs --tail=50 backend"
