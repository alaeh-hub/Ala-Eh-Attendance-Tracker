"""
Copy every table from the dev SQLite database into PostgreSQL (or any
SQLAlchemy URL), keeping ids and timestamps.

    cd backend
    .venv\\Scripts\\python tools\\migrate_to_postgres.py ^
        --source sqlite:///instance/attendance.db ^
        --target postgresql+psycopg2://attendance:PASSWORD@localhost:5432/attendance

The target must be empty (the script creates the tables and refuses to
copy into one that already has users). The source is only read. Back up
both databases first; verify the row counts it prints before switching
DATABASE_URL.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine, func, select  # noqa: E402


def migrate(source_url: str, target_url: str, batch: int = 500) -> dict:
    # Import models so every table is registered on the metadata.
    from app.extensions import db
    from app import models  # noqa: F401

    source, target = create_engine(source_url), create_engine(target_url)
    try:
        return _copy(source, target, db.metadata, batch)
    finally:
        source.dispose()
        target.dispose()


def _copy(source, target, metadata, batch):
    metadata.create_all(target)

    users = metadata.tables["users"]
    with target.connect() as conn:
        if conn.execute(select(func.count()).select_from(users)).scalar():
            raise SystemExit("Target already contains users. Refusing to copy into a non-empty database.")

    counts = {}
    with source.connect() as src, target.begin() as dst:
        for table in metadata.sorted_tables:       # parents before children
            if not source_has(source, table.name):
                continue
            total = 0
            result = src.execution_options(stream_results=True).execute(select(table))
            while True:
                rows = result.fetchmany(batch)
                if not rows:
                    break
                dst.execute(table.insert(), [dict(r._mapping) for r in rows])
                total += len(rows)
            counts[table.name] = total
    return counts


def source_has(engine, table_name: str) -> bool:
    from sqlalchemy import inspect
    return inspect(engine).has_table(table_name)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True)
    ap.add_argument("--target", required=True)
    args = ap.parse_args()
    for table, n in migrate(args.source, args.target).items():
        print(f"{table:20} {n} rows")
    print("Done. Point DATABASE_URL at the target and restart.")


if __name__ == "__main__":
    main()
