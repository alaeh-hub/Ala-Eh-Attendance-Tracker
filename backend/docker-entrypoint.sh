#!/bin/sh
# Container entrypoint for the backend.
#
# When starting the server (CMD begins with "gunicorn") it:
#   1. waits for the database to accept connections (DB_WAIT_SECONDS, default 90),
#   2. applies database migrations: python manage_db.py upgrade
#      (set RUN_MIGRATIONS=false to skip, e.g. when migrating by hand),
#   3. execs the server so it receives signals directly (graceful stop).
# Any other command (python seed_admin.py ..., sh, ...) is exec'd as is.
set -eu

if [ "${1:-}" = "gunicorn" ]; then
    python - <<'PY'
import os, sys, time

url = os.environ.get("DATABASE_URL", "")
if not url or url.startswith("sqlite"):
    sys.exit(0)

from sqlalchemy import create_engine, text

deadline = time.monotonic() + int(os.environ.get("DB_WAIT_SECONDS", "90"))
engine = create_engine(url, pool_pre_ping=True)
while True:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        print("entrypoint: database is reachable", flush=True)
        break
    except Exception as exc:  # noqa: BLE001
        if time.monotonic() > deadline:
            print(f"entrypoint: database still unreachable, giving up: {exc.__class__.__name__}", file=sys.stderr, flush=True)
            sys.exit(1)
        time.sleep(2)
engine.dispose()
PY

    if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
        if [ ! -f manage_db.py ]; then
            echo "entrypoint: manage_db.py not found; cannot apply migrations" >&2
            exit 1
        fi
        echo "entrypoint: applying database migrations"
        python manage_db.py upgrade
    else
        echo "entrypoint: RUN_MIGRATIONS=false, skipping migrations"
    fi
fi

exec "$@"
