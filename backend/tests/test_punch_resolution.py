"""
Which of the six kiosk punches a scan records, and when a scan records
nothing at all.

The kiosk button is a hint. These tests pin the two rules that make a
mis-pressed button harmless: the day's record decides In vs Out, and the
lunch break decides AM vs PM.
"""
import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app import create_app
from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.attendance_event import AttendanceEvent
from app.models.department import Department
from app.models.user import User
from app.services.attendance_service import (
    AlreadyVerified,
    CooldownActive,
    determine_event_type,
    record_attendance,
    resolve_punch,
)
from config import Config

ORG_TZ = ZoneInfo("Asia/Manila")


class TestConfig(Config):
    APP_ENV = "testing"
    SQLALCHEMY_DATABASE_URI = "sqlite://"
    TESTING = True
    ORG_TIMEZONE = "Asia/Manila"


def at(hour, minute=0):
    """Today at an org-local time, as the naive UTC the columns store."""
    local = datetime.now(ORG_TZ).replace(hour=hour, minute=minute, second=0, microsecond=0)
    return local.astimezone(timezone.utc).replace(tzinfo=None)


class PunchResolutionTests(unittest.TestCase):
    """8:00-17:00 department, 12:00-13:00 lunch."""

    def setUp(self):
        self.app = create_app(TestConfig)
        self.ctx = self.app.app_context()
        self.ctx.push()
        dept = Department(name="Operations", start_time="08:00", end_time="17:00",
                          break_start="12:00", break_end="13:00")
        user = User(full_name="Juan Dela Cruz", email="juan@example.test",
                    password_hash="x", department="Operations")
        db.session.add_all([dept, user])
        db.session.commit()
        self.user = user

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    # --- helpers -------------------------------------------------------

    def punch(self, hour, minute=0, want=None, session=None):
        """Record a scan as if the employee pressed `want`/`session`."""
        return record_attendance(
            user_id=self.user.id, match_score=0.9, match_status="MATCHED", liveness_passed=True,
            device_id="kiosk-1", event_type=want, session=session, timestamp=at(hour, minute),
        )

    def resolve(self, hour, minute=0, want=None, session=None):
        local = at(hour, minute).replace(tzinfo=timezone.utc).astimezone(ORG_TZ)
        return resolve_punch(self.user, local, want, session)

    def assertPunch(self, resolved, event_type, session):
        self.assertEqual((resolved.event_type, resolved.session), (event_type, session))

    # --- the four regular punches --------------------------------------

    def test_normal_day_fills_the_four_slots_in_order(self):
        self.assertPunch(self.punch(8, 0, "CLOCK_IN", "AM"), "CLOCK_IN", "AM")
        self.assertPunch(self.punch(12, 5, "CLOCK_OUT", "AM"), "CLOCK_OUT", "AM")
        self.assertPunch(self.punch(12, 55, "CLOCK_IN", "PM"), "CLOCK_IN", "PM")
        self.assertPunch(self.punch(17, 0, "CLOCK_OUT", "PM"), "CLOCK_OUT", "PM")
        self.assertEqual(AttendanceEvent.query.count(), 4)

    def test_lunch_break_not_noon_splits_am_from_pm(self):
        # Out at 12:05 is still the AM time out; back at 12:55 is the PM
        # time in. A literal noon split would get both of these wrong.
        self.punch(8, 0)
        self.assertPunch(self.resolve(12, 5), "CLOCK_OUT", "AM")
        self.punch(12, 5)
        self.assertPunch(self.resolve(12, 55), "CLOCK_IN", "PM")

    # --- the scenario from the brief ------------------------------------

    def test_pm_in_at_end_of_shift_is_recorded_as_pm_out(self):
        """Timed in before 8am, never punched for lunch, presses PM In at
        5pm. They are still timed in, so this can only be the PM time out."""
        self.punch(7, 55, "CLOCK_IN", "AM")
        event = self.punch(17, 0, "CLOCK_IN", "PM")
        self.assertEqual((event.event_type, event.session), ("CLOCK_OUT", "PM"))
        self.assertTrue(event.resolution.corrected)
        self.assertEqual(event.resolution.requested_label, "PM time in")
        self.assertIn("PM time out", event.resolution.note)
        self.assertIn("Auto:", event.notes)

    def test_no_regular_time_in_once_the_shift_has_ended(self):
        """Full day already worked; pressing PM In at 17:30 must not open a
        new regular session — it resolves to a time out and points at OT."""
        for h, m in ((8, 0), (12, 5), (12, 55)):
            self.punch(h, m)
        resolved = self.resolve(17, 30, "CLOCK_IN", "PM")
        self.assertPunch(resolved, "CLOCK_OUT", "PM")
        self.assertIn("OT In", resolved.note)

    def test_overtime_still_recordable_after_the_shift_ends(self):
        for h, m in ((8, 0), (12, 5), (12, 55), (17, 0)):
            self.punch(h, m)
        ot_in = self.punch(18, 0, "CLOCK_IN", "OT")
        self.assertEqual((ot_in.event_type, ot_in.session), ("CLOCK_IN", "OT"))
        self.assertFalse(ot_in.resolution.corrected)
        ot_out = self.punch(20, 0, "CLOCK_OUT", "OT")
        self.assertEqual((ot_out.event_type, ot_out.session), ("CLOCK_OUT", "OT"))

    def test_am_out_pressed_before_timing_in_records_the_time_in(self):
        resolved = self.resolve(8, 0, "CLOCK_OUT", "AM")
        self.assertPunch(resolved, "CLOCK_IN", "AM")
        self.assertIn("aren't timed in yet", resolved.note)

    def test_am_selection_in_the_afternoon_is_moved_to_pm(self):
        self.punch(8, 0)
        resolved = self.resolve(15, 0, "CLOCK_OUT", "AM")
        self.assertPunch(resolved, "CLOCK_OUT", "PM")
        self.assertTrue(resolved.corrected)

    def test_auto_selection_needs_no_correction(self):
        resolved = self.resolve(8, 0)
        self.assertPunch(resolved, "CLOCK_IN", "AM")
        self.assertFalse(resolved.corrected)
        self.assertIsNone(resolved.note)

    # --- re-verification window / no accidental second record -----------

    def test_rescan_inside_the_window_verifies_instead_of_recording(self):
        first = self.punch(8, 0, "CLOCK_IN", "AM")
        with self.assertRaises(AlreadyVerified) as caught:
            self.punch(8, 1, "CLOCK_OUT", "AM")
        self.assertEqual(caught.exception.last_event.id, first.id)
        self.assertGreater(caught.exception.seconds_remaining, 0)
        self.assertEqual(AttendanceEvent.query.count(), 1)

    def test_rescan_within_the_cooldown_is_reported_separately(self):
        self.punch(8, 0)
        with self.assertRaises(CooldownActive):
            self.punch(8, 0)

    def test_repeating_a_punch_after_the_window_does_not_duplicate_it(self):
        self.punch(8, 0, "CLOCK_IN", "AM")
        self.punch(12, 5, "CLOCK_OUT", "AM")
        self.punch(12, 55, "CLOCK_IN", "PM")
        self.punch(17, 0, "CLOCK_OUT", "PM")
        # Comes back an hour later and presses PM Out again.
        with self.assertRaises(AlreadyVerified) as caught:
            self.punch(18, 0, "CLOCK_OUT", "PM")
        self.assertIsNone(caught.exception.seconds_remaining)
        self.assertIn("already", caught.exception.reason)
        self.assertEqual(AttendanceEvent.query.count(), 4)

    # --- other departments ----------------------------------------------

    def test_shifting_department_has_no_shift_end_rule(self):
        dept = Department.query.filter_by(name="Operations").first()
        dept.has_shifting = True
        db.session.commit()
        self.app.config["SHIFT_END"] = ""
        self.punch(8, 0)
        self.punch(12, 5)
        # Nothing known about when this employee's day ends, so a scan at
        # 17:30 after timing out is an ordinary next time in.
        self.assertPunch(self.resolve(17, 30), "CLOCK_IN", "PM")

    def test_manual_admin_entry_is_written_exactly_as_asked(self):
        self.punch(8, 0, "CLOCK_IN", "AM")
        event = record_attendance(
            user_id=self.user.id, match_score=0.0, match_status="MANUAL", liveness_passed=False,
            device_id="manual", event_type="CLOCK_IN", session="PM", timestamp=at(8, 1),
            notes="Manual: camera down", enforce_cooldown=False,
        )
        # No cooldown, no window, no correction — the admin said PM In.
        self.assertEqual((event.event_type, event.session), ("CLOCK_IN", "PM"))
        self.assertIsNone(event.resolution)

    def test_rejects_an_unknown_session(self):
        with self.assertRaises(AppError):
            self.punch(8, 0, "CLOCK_IN", "EVENING")

    def test_regular_chain_spans_am_and_pm(self):
        db.session.add(AttendanceEvent(user_id=self.user.id, event_type="CLOCK_IN", session="AM",
                                       timestamp=at(8, 0), match_score=0.9, match_status="MATCHED"))
        db.session.commit()
        # Still timed in from the morning, so the next punch is an out even
        # though the PM session itself has no events yet.
        self.assertEqual(determine_event_type(self.user.id, "PM"), "CLOCK_OUT")
        # OT keeps its own chain and is unaffected.
        self.assertEqual(determine_event_type(self.user.id, "OT"), "CLOCK_IN")

    def test_yesterdays_events_do_not_carry_over(self):
        db.session.add(AttendanceEvent(user_id=self.user.id, event_type="CLOCK_IN", session="PM",
                                       timestamp=at(17, 0) - timedelta(days=1), match_score=0.9,
                                       match_status="MATCHED"))
        db.session.commit()
        self.assertPunch(self.resolve(8, 0), "CLOCK_IN", "AM")


if __name__ == "__main__":
    unittest.main()
