"""
Database schema management for deployments.

    python manage_db.py upgrade   # bring the database to the latest schema
    python manage_db.py current   # print the applied revision
    python manage_db.py check     # exit 1 if the models and migrations disagree

Production never relies on db.create_all(): every schema change ships as an
Alembic migration under migrations/ and is applied here before the server
starts (docker-entrypoint.sh runs `upgrade`).

Databases created by older versions of this app (via create_all and the
startup column updater, without an alembic_version table) are adopted
automatically: missing legacy columns are added, the database is stamped
at the baseline revision, and the newer migrations run from there.
"""
import os
import sys

# Schema work must never auto-create tables behind Alembic's back.
os.environ["AUTO_CREATE_SCHEMA"] = "false"

from flask_migrate import current as alembic_current  # noqa: E402
from flask_migrate import stamp, upgrade  # noqa: E402
from sqlalchemy import inspect  # noqa: E402

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402

BASELINE_REVISION = "0001_baseline"
MIGRATIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "migrations")


def _adopt_legacy_database() -> None:
    inspector = inspect(db.engine)
    tables = set(inspector.get_table_names())
    if "alembic_version" in tables or "users" not in tables:
        return
    from app.schema_upgrade import upgrade_schema

    print("Existing database without migration history: adopting it at the baseline revision.")
    upgrade_schema()
    stamp(directory=MIGRATIONS_DIR, revision=BASELINE_REVISION)


def cmd_upgrade() -> None:
    _adopt_legacy_database()
    upgrade(directory=MIGRATIONS_DIR)
    print("Database schema is up to date.")


def cmd_check() -> int:
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    with db.engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), db.metadata)
    if diff:
        print("Models and migrations disagree:")
        for item in diff:
            print("  ", item)
        return 1
    print("Models match the migrated schema.")
    return 0


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "upgrade"
    app = create_app()
    with app.app_context():
        if command == "upgrade":
            cmd_upgrade()
            return 0
        if command == "current":
            alembic_current(directory=MIGRATIONS_DIR)
            return 0
        if command == "check":
            cmd_upgrade()
            return cmd_check()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
