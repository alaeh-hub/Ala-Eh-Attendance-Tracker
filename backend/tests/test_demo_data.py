"""scripts/demo_data.py: argument checks, a reset that only removes what the generator made, and the review/audit rows."""
import argparse
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402
from app.models.attendance_event import AttendanceEvent  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.department import Department  # noqa: E402
from app.models.scan_snapshot import ScanSnapshot  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.auth_service import NO_LOGIN_HASH  # noqa: E402
from app.utils.timezone import utcnow  # noqa: E402
from config import Config  # noqa: E402

import demo_data  # noqa: E402


class TestConfig(Config):
    APP_ENV = "testing"
    TESTING = True
    SQLALCHEMY_DATABASE_URI = "sqlite://"
    RATE_LIMITS_ENABLED = False


class DemoDataTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app(TestConfig)
        self.ctx = self.app.app_context()
        self.ctx.push()
        db.create_all()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def _demo_users(self, n=3):
        depts, _ = demo_data.ensure_departments()
        return demo_data.make_employees(n, random.Random(1), depts, utcnow().date())

    # -- arguments ---------------------------------------------------------------------------------------------------
    def test_counts_must_be_positive_whole_numbers(self):
        parse = demo_data.bounded_int("--employees", 1, demo_data.MAX_EMPLOYEES)
        self.assertEqual(parse("60"), 60)
        for bad in ("0", "-5", "abc", str(demo_data.MAX_EMPLOYEES + 1)):
            with self.assertRaises(argparse.ArgumentTypeError, msg=bad):
                parse(bad)

    # -- reset only removes what the generator made --------------------------------------------------------------------
    def test_reset_keeps_a_real_account_that_uses_the_demo_domain(self):
        self._demo_users()
        real_admin = User(full_name="QA Lead", email="qa.lead@demo.test", password_hash="a-real-hash", role="ADMIN", employee_code="QA-1")
        real_staff = User(full_name="Real Staff", email="real.staff@demo.test", password_hash=NO_LOGIN_HASH, role="STAFF", employee_code="EMP-0007")
        db.session.add_all([real_admin, real_staff])
        db.session.commit()

        demo_data.reset()

        self.assertEqual(sorted(u.email for u in User.query.all()), ["qa.lead@demo.test", "real.staff@demo.test"])

    def test_every_marker_is_required_to_count_as_demo(self):
        user = User(full_name="X", email="x@demo.test", password_hash=NO_LOGIN_HASH, role="STAFF", employee_code="DEMO-0001")
        self.assertTrue(demo_data.is_demo_user(user))
        for change in ({"email": "x@example.test"}, {"employee_code": "EMP-1"}, {"password_hash": "real"}, {"role": "ADMIN"}):
            self.assertFalse(demo_data.is_demo_user(User(**{**dict(full_name="X", email="x@demo.test", password_hash=NO_LOGIN_HASH,
                                                                  role="STAFF", employee_code="DEMO-0001"), **change})), change)

    def test_reset_removes_a_demo_department_only_while_it_is_untouched(self):
        demo_data.ensure_departments()
        kitchen = Department.query.filter_by(name="Kitchen").one()
        kitchen.start_time = "05:00"           # an administrator changed it: no longer ours to delete
        db.session.commit()

        demo_data.reset()

        self.assertEqual([d.name for d in Department.query.all()], ["Kitchen"])

    # -- departments ---------------------------------------------------------------------------------------------------
    def test_an_existing_department_is_reused_with_a_warning_not_silently(self):
        custom = Department(name="Delivery", start_time="05:00", end_time="13:00", has_shifting=False, break_start="09:00", break_end="09:30")
        custom.shifts, custom.roles = [], ["Rider"]
        db.session.add(custom)
        db.session.commit()

        config, warnings = demo_data.ensure_departments()

        self.assertEqual(len(warnings), 1)
        self.assertIn("Delivery already exists with different settings", warnings[0])
        self.assertEqual(config["Delivery"]["start"], "05:00")                   # planned against what is really there
        self.assertEqual(Department.query.filter_by(name="Delivery").one().roles, ["Rider"])   # and left untouched

    def test_align_departments_overwrites_them_on_request(self):
        custom = Department(name="Delivery", start_time="05:00", end_time="13:00", has_shifting=False)
        custom.shifts, custom.roles = [], ["Rider"]
        db.session.add(custom)
        db.session.commit()

        config, warnings = demo_data.ensure_departments(align=True)

        self.assertEqual(warnings, [])
        delivery = Department.query.filter_by(name="Delivery").one()
        self.assertTrue(delivery.has_shifting)
        self.assertEqual([s["name"] for s in delivery.shifts], ["Morning", "Midday"])

    # -- review queue and audit trail --------------------------------------------------------------------------------------
    def test_review_cases_cover_every_status_and_are_removed_by_reset(self):
        users = self._demo_users(6)
        admin = User(full_name="Admin", email="admin@example.test", password_hash="hash", role="ADMIN")
        db.session.add(admin)
        db.session.commit()
        tally = demo_data.Counter()

        demo_data.make_review_cases(users, random.Random(3), utcnow(), admin.id, tally)

        statuses = {s.status for s in ScanSnapshot.query.all()}
        self.assertEqual(statuses, {"NO_MATCH", "LOW_CONFIDENCE", "AMBIGUOUS_MATCH", "SPOOF_SUSPECTED", "LIVENESS_FAILED"})
        pending = ScanSnapshot.query.filter(ScanSnapshot.resolution.is_(None), ScanSnapshot.status.in_(
            ("NO_MATCH", "LOW_CONFIDENCE", "AMBIGUOUS_MATCH", "SPOOF_SUSPECTED"))).count()
        self.assertGreater(pending, 10)
        self.assertGreater(ScanSnapshot.query.filter_by(resolution="DISMISSED").count(), 0)
        self.assertTrue(all(bytes(s.image)[:2] == b"\xff\xd8" or s.image for s in ScanSnapshot.query.all()))   # real JPEG data

        demo_data.reset()

        self.assertEqual(ScanSnapshot.query.count(), 0)
        self.assertEqual(AuditLog.query.count(), 0)

    def test_audit_rows_are_marked_and_a_real_one_survives_reset(self):
        users = self._demo_users(2)
        when = utcnow()
        demo_data.audit(None, "USER_CREATED", "user", users[0].id, {"email": users[0].email}, when)
        db.session.add(AuditLog(actor_user_id=None, action="USER_CREATED", target_type="user", target_id="real", details='{"email": "real@example.test"}'))
        db.session.commit()

        demo_data.reset()

        self.assertEqual([a.target_id for a in AuditLog.query.all()], ["real"])


if __name__ == "__main__":
    unittest.main()
