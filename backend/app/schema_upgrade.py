"""
Minimal forward-only schema upgrade for databases created before the
employee-profile columns existed. db.create_all() never alters existing
tables, so without this an old attendance.db would crash on startup.
ALTER TABLE ... ADD COLUMN works the same on SQLite and Postgres.
"""
from sqlalchemy import inspect, text

from app.extensions import db

_NEW_COLUMNS = {
    "users": {
        "employee_code": "VARCHAR(40)",
        "department": "VARCHAR(80)",
        "position": "VARCHAR(80)",
        "phone": "VARCHAR(40)",
        "photo": "BYTEA",  # rewritten to BLOB for SQLite below
        "updated_at": "TIMESTAMP",
        "biometric_consent_at": "TIMESTAMP",
        "biometric_consent_by": "VARCHAR(36)",
    },
    "face_embeddings": {
        "model": "VARCHAR(20)",
    },
    "attendance_events": {
        "session": "VARCHAR(2)",
    },
    "departments": {
        "break_start": "VARCHAR(5)",
        "break_end": "VARCHAR(5)",
    },
}


def upgrade_schema():
    inspector = inspect(db.engine)
    is_sqlite = db.engine.dialect.name == "sqlite"
    with db.engine.begin() as conn:
        for table, columns in _NEW_COLUMNS.items():
            if not inspector.has_table(table):
                continue
            existing = {c["name"] for c in inspector.get_columns(table)}
            for name, ddl_type in columns.items():
                if name in existing:
                    continue
                if is_sqlite and ddl_type == "BYTEA":
                    ddl_type = "BLOB"
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl_type}"))
                if table == "attendance_events" and name == "session":
                    _backfill_session(conn)
                if table == "departments" and name in ("break_start", "break_end"):
                    default = "12:00" if name == "break_start" else "13:00"
                    conn.execute(text(f"UPDATE departments SET {name} = :v WHERE {name} IS NULL"), {"v": default})
        indexes = {i["name"] for i in inspector.get_indexes("users")}
        if "ix_users_employee_code" not in indexes:
            conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_employee_code ON users (employee_code)"))


def _backfill_session(conn):
    """Derive AM/PM for pre-existing rows from their org-local hour (events before this feature predate the AM/PM split, so there's no recorded intent to preserve)."""
    from datetime import datetime

    from app.utils.timezone import to_org_tz

    rows = conn.execute(text("SELECT id, timestamp FROM attendance_events WHERE session IS NULL")).fetchall()
    for row_id, timestamp in rows:
        if isinstance(timestamp, str):
            timestamp = datetime.fromisoformat(timestamp)
        local_hour = to_org_tz(timestamp).hour
        session = "AM" if local_hour < 12 else "PM"
        conn.execute(text("UPDATE attendance_events SET session = :session WHERE id = :id"), {"session": session, "id": row_id})
