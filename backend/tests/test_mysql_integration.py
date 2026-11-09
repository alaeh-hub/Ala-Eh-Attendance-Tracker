"""Behaviour that only a real MySQL server can show.

The rest of the suite runs on in-memory SQLite. These tests exist for what SQLite
cannot tell us: that the migrations build the right schema on MySQL, that column
types are big and precise enough, and that the punch lock really serialises
concurrent scans.

Skipped unless TEST_MYSQL_URL is set, e.g.

    TEST_MYSQL_URL=mysql+pymysql://root:PASSWORD@127.0.0.1:3306/attendance_test

The schema is DROPPED and recreated, so its name must end in "_test".
"""
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, make_url

TEST_URL = os.environ.get("TEST_MYSQL_URL", "")


@unittest.skipUnless(TEST_URL, "set TEST_MYSQL_URL to a MySQL URL whose database name ends in _test")
class MySQLIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from config import Config, database_uri

        url = make_url(TEST_URL)
        assert url.database and url.database.endswith("_test"), "TEST_MYSQL_URL's database name must end in _test"
        # URL.set(database=None) means "unchanged", so the server-level URL is built explicitly.
        admin = create_engine(URL.create(url.drivername, url.username, url.password, url.host, url.port, query=url.query))
        with admin.begin() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS `{url.database}`"))
            conn.execute(text(f"CREATE DATABASE `{url.database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"))
        admin.dispose()

        class MySQLConfig(Config):
            APP_ENV = "testing"
            # create_app runs create_all() whenever TESTING is on, which would pre-empt the
            # migrations; this test wants the migrations to build the schema.
            TESTING = False
            AUTO_CREATE_SCHEMA = False
            SQLALCHEMY_DATABASE_URI = database_uri(TEST_URL)
            RATE_LIMITS_ENABLED = False

        from app import create_app

        cls.app = create_app(MySQLConfig)
        # The real migrations build the schema, so they are tested on MySQL too.
        from flask_migrate import upgrade

        with cls.app.app_context():
            upgrade(directory=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "migrations"))

    @classmethod
    def tearDownClass(cls):
        from app.extensions import db

        with cls.app.app_context():
            db.session.remove()
            db.engine.dispose()

    def setUp(self):
        self.ctx = self.app.app_context()
        self.ctx.push()
        from app.extensions import db

        self.db = db

    def tearDown(self):
        self.db.session.rollback()
        for table in ("scan_snapshots", "attendance_events", "face_embeddings", "users"):
            self.db.session.execute(text(f"DELETE FROM {table}"))
        self.db.session.commit()
        self.db.session.remove()
        self.ctx.pop()

    def _user(self, **over):
        from app.models.user import User

        fields = dict(full_name="Juan Dela Cruz", email=f"u{os.urandom(4).hex()}@example.test", password_hash="x", role="STAFF")
        fields.update(over)
        user = User(**fields)
        self.db.session.add(user)
        self.db.session.commit()
        return user

    def test_migrations_produce_exactly_the_models_schema(self):
        from alembic.autogenerate import compare_metadata
        from alembic.migration import MigrationContext

        with self.db.engine.connect() as conn:
            diff = compare_metadata(MigrationContext.configure(conn, opts={"compare_type": True}), self.db.metadata)
        self.assertEqual(diff, [])

    def test_connections_use_read_committed_and_utf8mb4(self):
        row = self.db.session.execute(text("SELECT @@transaction_isolation, @@character_set_client")).one()
        self.assertEqual(row[0], "READ-COMMITTED")
        self.assertEqual(row[1], "utf8mb4")

    def test_binary_columns_hold_more_than_a_64k_blob(self):
        from app.models.scan_snapshot import ScanSnapshot

        image = os.urandom(300_000)  # a scan snapshot is a JPEG: easily past MySQL's 64 KB BLOB
        photo = os.urandom(120_000)
        user = self._user(photo=photo)
        snap = ScanSnapshot(user_id=user.id, status="MATCHED", image=image)
        self.db.session.add(snap)
        self.db.session.commit()
        self.db.session.expire_all()
        self.assertEqual(bytes(self.db.session.get(ScanSnapshot, snap.id).image), image)
        self.assertEqual(bytes(self.db.session.get(type(user), user.id).photo), photo)

    def test_timestamps_keep_microseconds(self):
        from app.models.attendance_event import AttendanceEvent

        user = self._user()
        first = datetime(2026, 11, 9, 1, 0, 0, 123456)
        events = [
            AttendanceEvent(user_id=user.id, event_type="CLOCK_IN", session="AM", timestamp=first,
                            match_score=0.9, match_status="MATCHED"),
            AttendanceEvent(user_id=user.id, event_type="CLOCK_OUT", session="AM", timestamp=first + timedelta(microseconds=500),
                            match_score=0.9, match_status="MATCHED"),
        ]
        self.db.session.add_all(events)
        self.db.session.commit()
        self.db.session.expire_all()
        stored = AttendanceEvent.query.order_by(AttendanceEvent.timestamp.desc()).all()
        self.assertEqual(stored[0].timestamp, first + timedelta(microseconds=500))
        self.assertEqual(stored[0].event_type, "CLOCK_OUT")  # same second, still ordered

    def test_names_with_any_unicode_survive(self):
        user = self._user(full_name="Zoë Ñuñez 王芳 🙂")
        self.db.session.expire_all()
        self.assertEqual(type(user).query.get(user.id).full_name, "Zoë Ñuñez 王芳 🙂")

    def test_emails_are_unique_ignoring_case(self):
        from sqlalchemy.exc import IntegrityError

        self._user(email="maria@example.test")
        with self.assertRaises(IntegrityError):
            self._user(email="MARIA@example.test")
        self.db.session.rollback()

    def test_concurrent_scans_for_one_employee_record_one_punch(self):
        """The row lock plus READ COMMITTED: N simultaneous scans -> exactly one event."""
        from app.models.attendance_event import AttendanceEvent
        from app.services.attendance_service import AlreadyVerified, CooldownActive, record_attendance

        user = self._user(employee_code="EMP-9001")
        user_id = user.id
        self.db.session.remove()
        barrier = threading.Barrier(6)
        outcomes = []

        def scan():
            with self.app.app_context():
                barrier.wait()
                try:
                    record_attendance(user_id, 0.95, "MATCHED", True, device_id="test-kiosk")
                    outcomes.append("recorded")
                except (CooldownActive, AlreadyVerified):
                    outcomes.append("refused")
                finally:
                    self.db.session.remove()

        with ThreadPoolExecutor(max_workers=6) as pool:
            for future in [pool.submit(scan) for _ in range(6)]:
                future.result(timeout=60)

        self.assertEqual(outcomes.count("recorded"), 1, outcomes)
        self.assertEqual(AttendanceEvent.query.filter_by(user_id=user_id).count(), 1)


if __name__ == "__main__":
    unittest.main()
