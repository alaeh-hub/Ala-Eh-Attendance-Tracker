"""
Work days, night and rotating shifts, stamped lateness, and the report /
attendance endpoints that read them.

The org runs on Asia/Manila. Every punch uses an explicit timestamp a few
days in the past (no clock freezing): `local(day, h, m)` turns an org-local
wall time into the naive UTC the columns store.
"""
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock
from zoneinfo import ZoneInfo

from flask_jwt_extended import create_access_token

from app import create_app
from app.extensions import db
from app.models.attendance_event import AttendanceEvent
from app.models.audit_log import AuditLog
from app.models.department import Department
from app.models.user import User
from app.services.attendance_service import event_payload, record_attendance
from app.utils.audit import log_action
from config import Config

ORG_TZ = ZoneInfo("Asia/Manila")


class TestConfig(Config):
    APP_ENV = "testing"
    SQLALCHEMY_DATABASE_URI = "sqlite://"
    TESTING = True
    ORG_TIMEZONE = "Asia/Manila"
    RATE_LIMITS_ENABLED = False


def local(day: date, hour: int, minute: int = 0) -> datetime:
    """Org-local wall time on `day` as naive UTC."""
    aware = datetime(day.year, day.month, day.day, hour, minute, tzinfo=ORG_TZ)
    return aware.astimezone(timezone.utc).replace(tzinfo=None)


def to_local(naive_utc: datetime) -> datetime:
    return naive_utc.replace(tzinfo=timezone.utc).astimezone(ORG_TZ)


class Base(unittest.TestCase):
    def setUp(self):
        self.app = create_app(TestConfig)
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.client = self.app.test_client()
        # A fixed past day, far enough back that no punch is "in the future".
        self.day = datetime.now(ORG_TZ).date() - timedelta(days=5)
        # can_login wants a bcrypt hash; it is never checked (tokens are minted directly).
        self.admin = User(full_name="Admin", email="admin@example.test", password_hash="$2b$12$" + "x" * 53, role="ADMIN")
        db.session.add(self.admin)
        db.session.commit()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    # --- helpers -------------------------------------------------------
    def auth(self):
        token = create_access_token(identity=self.admin.id, additional_claims={"tv": self.admin.token_version or 0})
        return {"Authorization": f"Bearer {token}"}

    def employee(self, name: str, department: str | None) -> User:
        user = User(full_name=name, email=f"{name.lower().replace(' ', '.')}@example.test",
                    password_hash="x", department=department)
        db.session.add(user)
        db.session.commit()
        return user

    def department(self, name, **kw) -> Department:
        shifts = kw.pop("shifts", None)
        dept = Department(name=name, **kw)
        if shifts:
            dept.shifts = shifts
        db.session.add(dept)
        db.session.commit()
        return dept

    def punch(self, user, ts, want=None, session=None):
        """A live kiosk scan at naive-UTC `ts`."""
        return record_attendance(user.id, 0.9, "MATCHED", True, "kiosk-1",
                                 event_type=want, session=session, timestamp=ts)

    def events(self, user):
        return (AttendanceEvent.query.filter_by(user_id=user.id)
                .order_by(AttendanceEvent.timestamp.asc()).all())

    def daily(self, day_from, day_to=None, **params):
        res = self.client.get("/api/reports/daily", headers=self.auth(), query_string={
            "from": day_from.isoformat(), "to": (day_to or day_from).isoformat(), **params})
        self.assertEqual(res.status_code, 200, res.json)
        return res.json


class OvernightFixedShiftTests(Base):
    """22:00-06:00 with a 02:00-03:00 break."""

    def setUp(self):
        super().setUp()
        self.department("Night", start_time="22:00", end_time="06:00", break_start="02:00", break_end="03:00")
        self.user = self.employee("Nora Night", "Night")
        self.next = self.day + timedelta(days=1)

    def test_in_before_and_out_after_midnight_is_one_work_day(self):
        ev_in = self.punch(self.user, local(self.day, 21, 55), "CLOCK_IN", "AM")
        ev_out = self.punch(self.user, local(self.next, 6, 5), "CLOCK_OUT", "PM")

        self.assertEqual((ev_in.event_type, ev_in.session), ("CLOCK_IN", "AM"))
        self.assertEqual((ev_out.event_type, ev_out.session), ("CLOCK_OUT", "PM"))
        self.assertEqual(ev_in.work_date, self.day)
        self.assertEqual(ev_out.work_date, self.day)
        self.assertEqual((ev_in.scheduled_start, ev_in.scheduled_end), ("22:00", "06:00"))
        self.assertEqual(ev_in.late_minutes, 0)
        self.assertEqual(ev_out.early_minutes, 0)

        payload = event_payload(ev_out)
        self.assertEqual(payload["work_date"], self.day.isoformat())
        self.assertFalse(payload["is_early_leave"])
        self.assertFalse(event_payload(ev_in)["is_late"])

        rows = self.daily(self.day)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["date"], self.day.isoformat())
        # 21:55 -> 06:05 is 8h10m, minus the 1h break straddled = 7h10m.
        self.assertAlmostEqual(row["hours"], 7.17, places=2)
        self.assertFalse(row["late"])
        self.assertFalse(row["open"])
        # The 06:05 punch does not create a second (empty) row for the next day.
        self.assertEqual(self.daily(self.next), [])

    def test_late_and_early_leave_across_midnight(self):
        ev_in = self.punch(self.user, local(self.day, 22, 40), "CLOCK_IN")
        ev_out = self.punch(self.user, local(self.next, 5, 0), "CLOCK_OUT")
        self.assertEqual(ev_in.late_minutes, 25)  # 15 min grace
        self.assertEqual(ev_out.session, "PM")
        self.assertEqual(ev_out.early_minutes, 60)
        row = self.daily(self.day)[0]
        self.assertTrue(row["late"])
        self.assertEqual(row["late_minutes"], 25)
        self.assertEqual(row["early_minutes"], 60)

    def test_break_punches_split_halves_after_midnight(self):
        self.punch(self.user, local(self.day, 22, 0), "CLOCK_IN")
        out = self.punch(self.user, local(self.next, 2, 0), "CLOCK_OUT")
        back = self.punch(self.user, local(self.next, 2, 58), "CLOCK_IN")
        done = self.punch(self.user, local(self.next, 6, 0), "CLOCK_OUT")
        self.assertEqual([(e.event_type, e.session) for e in (out, back, done)],
                         [("CLOCK_OUT", "AM"), ("CLOCK_IN", "PM"), ("CLOCK_OUT", "PM")])
        self.assertTrue(all(e.work_date == self.day for e in self.events(self.user)))
        self.assertIsNone(back.late_minutes)  # only the day's first time in is judged
        # 4h + 3h02m, but the 2 minutes back before the break ended are unpaid.
        self.assertAlmostEqual(self.daily(self.day)[0]["hours"], 7.0, places=2)

    def test_auto_lunch_out_across_midnight(self):
        self.punch(self.user, local(self.day, 22, 0), "CLOCK_IN")
        back = self.punch(self.user, local(self.next, 3, 10), "CLOCK_IN")
        evs = self.events(self.user)
        self.assertEqual([(e.event_type, e.session) for e in evs],
                         [("CLOCK_IN", "AM"), ("CLOCK_OUT", "AM"), ("CLOCK_IN", "PM")])
        self.assertEqual(to_local(evs[1].timestamp).replace(tzinfo=None),
                         datetime(self.next.year, self.next.month, self.next.day, 2, 0))
        self.assertEqual(back.work_date, self.day)

    def test_shift_over_next_morning_is_a_time_out_not_a_new_day(self):
        self.punch(self.user, local(self.day, 22, 0), "CLOCK_IN")
        self.punch(self.user, local(self.next, 6, 0), "CLOCK_OUT")
        # Pressing time in again at 06:30: the shift is over, so the slot
        # rule reassures instead of starting a new work day.
        from app.services.attendance_service import AlreadyVerified
        with self.assertRaises(AlreadyVerified):
            self.punch(self.user, local(self.next, 6, 30), "CLOCK_IN")
        # The next evening opens the next work day.
        ev = self.punch(self.user, local(self.next, 21, 58), "CLOCK_IN")
        self.assertEqual((ev.event_type, ev.session, ev.work_date), ("CLOCK_IN", "AM", self.next))

    def test_today_report_counts_night_worker_currently_in_after_midnight(self):
        self.punch(self.user, local(self.day, 22, 0), "CLOCK_IN")
        fake_now = local(self.next, 3, 0)
        with mock.patch("app.api.report_routes.utcnow", return_value=fake_now):
            today = self.client.get("/api/reports/today", headers=self.auth()).json
        self.assertEqual(today["present"], 1)
        self.assertEqual(today["currently_in"], 1)
        self.assertEqual(today["late"], 0)
        # And the open shift's hours run up to "now", break excluded.
        with mock.patch("app.api.report_routes.utcnow", return_value=fake_now):
            row = self.daily(self.day)[0]
        self.assertTrue(row["open"])
        self.assertAlmostEqual(row["hours"], 4.0, places=2)


class RotatingShiftTests(Base):
    def setUp(self):
        super().setUp()
        self.department("Plant", has_shifting=True, break_start="12:00", break_end="13:00", shifts=[
            {"name": "Morning", "start_time": "06:00", "end_time": "14:00"},
            {"name": "Swing", "start_time": "14:00", "end_time": "22:00"},
            {"name": "Graveyard", "start_time": "22:00", "end_time": "06:00"},
        ])
        self.user = self.employee("Rita Rotate", "Plant")

    def test_on_time_for_afternoon_shift(self):
        ev = self.punch(self.user, local(self.day, 14, 5), "CLOCK_IN")
        self.assertEqual(ev.scheduled_start, "14:00")
        self.assertEqual(ev.late_minutes, 0)
        self.assertFalse(event_payload(ev)["is_late"])

    def test_early_arrival_matches_upcoming_shift_and_is_not_late(self):
        ev = self.punch(self.user, local(self.day, 12, 30), "CLOCK_IN")
        self.assertEqual(ev.scheduled_start, "14:00")
        self.assertEqual(ev.late_minutes, 0)

    def test_late_for_afternoon_shift(self):
        ev = self.punch(self.user, local(self.day, 14, 40), "CLOCK_IN")
        self.assertEqual(ev.scheduled_start, "14:00")
        self.assertEqual(ev.late_minutes, 25)
        self.assertEqual(event_payload(ev)["late_minutes"], 25)

    def test_graveyard_shift_pairs_across_midnight(self):
        nxt = self.day + timedelta(days=1)
        ev_in = self.punch(self.user, local(self.day, 22, 10), "CLOCK_IN")
        ev_out = self.punch(self.user, local(nxt, 6, 0), "CLOCK_OUT")
        self.assertEqual(ev_in.scheduled_start, "22:00")
        self.assertEqual(ev_out.event_type, "CLOCK_OUT")
        self.assertEqual(ev_out.work_date, self.day)
        rows = self.daily(self.day, nxt)
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["hours"], 7.83, places=2)  # 22:10 -> 06:00, noon break n/a

    def test_no_matching_shift_is_never_late(self):
        self.department("Bakery", has_shifting=True, shifts=[
            {"name": "Dawn", "start_time": "04:00", "end_time": "10:00"},
        ])
        baker = self.employee("Ben Baker", "Bakery")
        ev = self.punch(baker, local(self.day, 18, 0), "CLOCK_IN")
        self.assertIsNone(ev.scheduled_start)
        self.assertIsNone(ev.late_minutes)
        self.assertFalse(event_payload(ev)["is_late"])


class StampedLatenessTests(Base):
    def setUp(self):
        super().setUp()
        self.dept = self.department("Ops", start_time="08:00", end_time="17:00",
                                    break_start="12:00", break_end="13:00")
        self.user = self.employee("Olga Ops", "Ops")

    def list_events(self, **params):
        res = self.client.get("/api/attendance", headers=self.auth(), query_string=params)
        self.assertEqual(res.status_code, 200, res.json)
        return res

    def test_editing_the_department_does_not_rewrite_history(self):
        self.punch(self.user, local(self.day, 8, 30), "CLOCK_IN")
        res = self.client.patch(f"/api/departments/{self.dept.id}", headers=self.auth(),
                                json={"start_time": "09:00"})
        self.assertEqual(res.status_code, 200, res.json)
        ev = self.list_events().json[0]
        self.assertEqual(ev["late_minutes"], 15)
        self.assertEqual(ev["scheduled_start"], "08:00")
        self.assertTrue(self.daily(self.day)[0]["late"])

    def test_legacy_rows_fall_back_to_the_current_schedule(self):
        db.session.add(AttendanceEvent(user_id=self.user.id, event_type="CLOCK_IN", session="AM",
                                       timestamp=local(self.day, 8, 30), match_score=0.9,
                                       match_status="MATCHED"))
        db.session.commit()
        ev = self.list_events().json[0]
        self.assertEqual(ev["late_minutes"], 15)
        self.assertEqual(ev["work_date"], self.day.isoformat())
        self.dept.start_time = "09:00"
        db.session.commit()
        self.assertIsNone(self.list_events().json[0]["late_minutes"])


class DepartmentAuditTests(Base):
    def test_create_update_delete_are_audited(self):
        res = self.client.post("/api/departments", headers=self.auth(), json={
            "name": "Night", "start_time": "22:00", "end_time": "06:00",
            "break_start": "02:00", "break_end": "03:00"})
        self.assertEqual(res.status_code, 201, res.json)
        dept_id = res.json["id"]
        res = self.client.patch(f"/api/departments/{dept_id}", headers=self.auth(),
                                json={"break_start": "01:30", "break_end": "02:30"})
        self.assertEqual(res.status_code, 200, res.json)
        res = self.client.delete(f"/api/departments/{dept_id}", headers=self.auth())
        self.assertEqual(res.status_code, 200, res.json)

        logs = {log.action: log for log in AuditLog.query.filter_by(target_id=dept_id).all()}
        self.assertEqual(set(logs), {"DEPARTMENT_CREATED", "DEPARTMENT_UPDATED", "DEPARTMENT_DELETED"})
        self.assertTrue(all(log.actor_user_id == self.admin.id for log in logs.values()))
        updated = json.loads(logs["DEPARTMENT_UPDATED"].details)
        self.assertEqual(updated["changes"]["break_start"], {"before": "02:00", "after": "01:30"})
        self.assertEqual(updated["before"]["break_end"], "03:00")
        self.assertEqual(json.loads(logs["DEPARTMENT_CREATED"].details)["after"]["start_time"], "22:00")
        self.assertEqual(json.loads(logs["DEPARTMENT_DELETED"].details)["before"]["name"], "Night")

    def test_no_op_update_is_not_audited(self):
        dept = self.department("Ops", start_time="08:00", end_time="17:00")
        res = self.client.patch(f"/api/departments/{dept.id}", headers=self.auth(), json={"start_time": "08:00"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(AuditLog.query.filter_by(action="DEPARTMENT_UPDATED").count(), 0)

    def test_schedule_validation(self):
        post = lambda **body: self.client.post("/api/departments", headers=self.auth(), json=body)
        # A break after midnight inside a night shift, and one crossing midnight.
        self.assertEqual(post(name="A", start_time="22:00", end_time="06:00",
                              break_start="23:30", break_end="00:30").status_code, 201)
        # A break outside the overnight shift, set explicitly.
        self.assertEqual(post(name="B", start_time="22:00", end_time="06:00",
                              break_start="12:00", break_end="13:00").status_code, 400)
        # Straddling the end of the shift.
        self.assertEqual(post(name="C", start_time="08:00", end_time="17:00",
                              break_start="16:30", break_end="17:30").status_code, 400)
        # Half a schedule, a zero-length shift, a zero-length break.
        self.assertEqual(post(name="D", start_time="08:00").status_code, 400)
        self.assertEqual(post(name="E", start_time="08:00", end_time="08:00").status_code, 400)
        self.assertEqual(post(name="F", break_start="12:00", break_end="12:00").status_code, 400)
        # Rotating: a shared noon break may sit outside the night shift,
        # but not straddle a shift boundary.
        shifts = [{"name": "Day", "start_time": "06:00", "end_time": "14:00"},
                  {"name": "Night", "start_time": "22:00", "end_time": "06:00"}]
        self.assertEqual(post(name="G", has_shifting=True, shifts=shifts,
                              break_start="12:00", break_end="13:00").status_code, 201)
        self.assertEqual(post(name="H", has_shifting=True, shifts=shifts,
                              break_start="13:30", break_end="14:30").status_code, 400)
        self.assertEqual(post(name="I", has_shifting=True,
                              shifts=[{"name": "X", "start_time": "09:00", "end_time": "09:00"}]).status_code, 400)


class ManualEntryAndCorrectionTests(Base):
    def setUp(self):
        super().setUp()
        self.dept = self.department("Ops", start_time="08:00", end_time="17:00",
                                    break_start="12:00", break_end="13:00")
        self.user = self.employee("Olga Ops", "Ops")

    def manual(self, **body):
        body = {"user_id": self.user.id, "notes": "camera down", **body}
        return self.client.post("/api/attendance", headers=self.auth(), json=body)

    def test_future_timestamp_rejected(self):
        future = (datetime.now(ORG_TZ) + timedelta(hours=1)).replace(tzinfo=None)
        res = self.manual(event_type="CLOCK_IN", timestamp=future.isoformat(timespec="seconds"))
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json["code"], "FUTURE_TIMESTAMP")
        # A couple of minutes of browser clock skew is fine.
        near = (datetime.now(ORG_TZ) + timedelta(minutes=2)).replace(tzinfo=None)
        self.assertEqual(self.manual(event_type="CLOCK_IN", timestamp=near.isoformat(timespec="seconds")).status_code, 201)

    def test_naive_timestamp_is_org_local_and_session_follows_the_break(self):
        res = self.manual(event_type="CLOCK_IN", timestamp=f"{self.day.isoformat()}T08:20:00")
        self.assertEqual(res.status_code, 201, res.json)
        ev = db.session.get(AttendanceEvent, res.json["id"])
        self.assertEqual(ev.timestamp, local(self.day, 8, 20))
        self.assertEqual(res.json["session"], "AM")
        self.assertEqual(res.json["late_minutes"], 5)
        self.assertEqual(res.json["work_date"], self.day.isoformat())

        out = self.manual(event_type="CLOCK_OUT", timestamp=f"{self.day.isoformat()}T12:30:00")
        self.assertEqual(out.json["session"], "AM")  # lunch time out, not PM because it's past noon
        back = self.manual(event_type="CLOCK_IN", timestamp=f"{self.day.isoformat()}T12:55:00")
        self.assertEqual(back.json["session"], "PM")

        audit = AuditLog.query.filter_by(action="ATTENDANCE_MANUAL_ENTRY", target_id=ev.id).one()
        self.assertEqual(json.loads(audit.details)["reason"], "camera down")

    def test_bad_timestamp_rejected(self):
        self.assertEqual(self.manual(event_type="CLOCK_IN", timestamp="yesterday").status_code, 400)

    def test_correction_with_timestamp_change_restamps_and_audits(self):
        ev = self.punch(self.user, local(self.day, 8, 5), "CLOCK_IN")
        self.assertEqual(ev.late_minutes, 0)
        res = self.client.patch(f"/api/attendance/{ev.id}", headers=self.auth(),
                                json={"timestamp": f"{self.day.isoformat()}T08:45:00", "notes": "badge fix"})
        self.assertEqual(res.status_code, 200, res.json)
        self.assertEqual(res.json["late_minutes"], 30)
        self.assertTrue(res.json["is_late"])
        self.assertEqual(res.json["notes"], "badge fix")

        audit = AuditLog.query.filter_by(action="ATTENDANCE_CORRECTED", target_id=ev.id).one()
        details = json.loads(audit.details)
        self.assertEqual(details["before"]["late_minutes"], 0)
        self.assertEqual(details["after"]["late_minutes"], 30)
        self.assertNotEqual(details["before"]["timestamp"], details["after"]["timestamp"])

    def test_correction_changes_type_and_session(self):
        ev = self.punch(self.user, local(self.day, 16, 0), "CLOCK_IN")
        res = self.client.patch(f"/api/attendance/{ev.id}", headers=self.auth(),
                                json={"event_type": "CLOCK_OUT", "session": "PM"})
        self.assertEqual(res.status_code, 200, res.json)
        self.assertEqual((res.json["event_type"], res.json["session"]), ("CLOCK_OUT", "PM"))
        self.assertEqual(res.json["early_minutes"], 60)
        self.assertIsNone(res.json["late_minutes"])

    def test_correction_rejects_future_and_bad_values(self):
        ev = self.punch(self.user, local(self.day, 8, 0), "CLOCK_IN")
        future = (datetime.now(ORG_TZ) + timedelta(days=1)).replace(tzinfo=None).isoformat(timespec="seconds")
        for body in ({"timestamp": future}, {"session": "XX"}, {"event_type": "BREAK"}, {}):
            res = self.client.patch(f"/api/attendance/{ev.id}", headers=self.auth(), json=body)
            self.assertEqual(res.status_code, 400, body)

    def test_deleting_the_first_time_in_moves_lateness_to_the_next(self):
        first = self.punch(self.user, local(self.day, 8, 0), "CLOCK_IN")
        self.punch(self.user, local(self.day, 12, 0), "CLOCK_OUT")
        second = self.punch(self.user, local(self.day, 13, 0), "CLOCK_IN")
        self.assertIsNone(second.late_minutes)
        res = self.client.delete(f"/api/attendance/{first.id}", headers=self.auth())
        self.assertEqual(res.status_code, 200)
        db.session.refresh(second)
        self.assertEqual(second.late_minutes, 4 * 60 + 45)


class PaginationTests(Base):
    def test_attendance_offset_and_total_header(self):
        user = self.employee("Paul Page", None)
        for i in range(5):
            record_attendance(user.id, 0.0, "MANUAL", False, "manual", event_type="CLOCK_IN", session="OT",
                              timestamp=local(self.day, 8 + i), notes=f"n{i}", enforce_cooldown=False)
        res = self.client.get("/api/attendance", headers=self.auth(), query_string={"limit": 2, "offset": 1})
        self.assertEqual(res.status_code, 200)
        self.assertIsInstance(res.json, list)
        self.assertEqual(res.headers["X-Total-Count"], "5")
        self.assertEqual([e["notes"] for e in res.json], ["n3", "n2"])  # newest first
        self.assertEqual(self.client.get("/api/attendance", headers=self.auth(),
                                         query_string={"limit": "x"}).status_code, 400)

    def test_audit_paging_and_filters(self):
        for i in range(4):
            log_action(self.admin.id, "USER_UPDATED", "user", f"u{i}")
        log_action(self.admin.id, "ATTENDANCE_DELETED", "attendance_event", "e1")
        old = AuditLog(actor_user_id=self.admin.id, action="USER_UPDATED", target_id="old",
                       created_at=datetime.utcnow() - timedelta(days=40))
        db.session.add(old)
        db.session.commit()

        res = self.client.get("/api/reports/audit", headers=self.auth(), query_string={"limit": 2, "offset": 1})
        self.assertEqual(res.status_code, 200)
        self.assertIsInstance(res.json, list)
        self.assertEqual(len(res.json), 2)
        self.assertEqual(res.headers["X-Total-Count"], "6")
        self.assertEqual(res.json[0]["actor_name"], "Admin")

        res = self.client.get("/api/reports/audit", headers=self.auth(), query_string={"action": "user_updated"})
        self.assertEqual(res.headers["X-Total-Count"], "5")
        since = (datetime.now(ORG_TZ).date() - timedelta(days=7)).isoformat()
        res = self.client.get("/api/reports/audit", headers=self.auth(),
                              query_string={"action": "USER_UPDATED", "from": since})
        self.assertEqual(res.headers["X-Total-Count"], "4")
        until = (datetime.now(ORG_TZ).date() - timedelta(days=30)).isoformat()
        res = self.client.get("/api/reports/audit", headers=self.auth(), query_string={"to": until})
        self.assertEqual([r["target_id"] for r in res.json], ["old"])
        self.assertEqual(self.client.get("/api/reports/audit", headers=self.auth(),
                                         query_string={"from": "2026-13-01"}).status_code, 400)


class ReportGroupingTests(Base):
    def test_rows_group_by_work_date_and_csv_carries_it(self):
        self.department("Night", start_time="22:00", end_time="06:00", break_start="02:00", break_end="03:00")
        self.department("Ops", start_time="08:00", end_time="17:00", break_start="12:00", break_end="13:00")
        night = self.employee("Nina Night", "Night")
        ops = self.employee("Omar Ops", "Ops")
        nxt = self.day + timedelta(days=1)
        for d in (self.day, nxt):
            self.punch(night, local(d, 22, 0), "CLOCK_IN")
            self.punch(night, local(d + timedelta(days=1), 6, 0), "CLOCK_OUT")
            self.punch(ops, local(d, 8, 0), "CLOCK_IN")
            self.punch(ops, local(d, 17, 0), "CLOCK_OUT")

        rows = self.daily(self.day, nxt)
        self.assertEqual(len(rows), 4)
        by_key = {(r["user_name"], r["date"]): r for r in rows}
        for d in (self.day, nxt):
            self.assertAlmostEqual(by_key[("Nina Night", d.isoformat())]["hours"], 7.0, places=2)
            self.assertAlmostEqual(by_key[("Omar Ops", d.isoformat())]["hours"], 8.0, places=2)

        summary = self.client.get("/api/reports/hours-summary", headers=self.auth(), query_string={
            "from": self.day.isoformat(), "to": nxt.isoformat()}).json
        nina = next(p for p in summary["employees"] if p["user_name"] == "Nina Night")
        self.assertEqual(nina["days_worked"], 2)
        self.assertAlmostEqual(nina["hours"], 14.0, places=2)

        res = self.client.get("/api/reports/export.csv", headers=self.auth(),
                              query_string={"user_id": night.id})
        lines = res.get_data(as_text=True).lstrip("﻿").strip().splitlines()
        header = lines[0].split(",")
        work_col = header.index("Work date")
        out_row = lines[2].split(",")  # the first 06:00 time out
        self.assertEqual(out_row[0], nxt.isoformat())
        self.assertEqual(out_row[work_col], self.day.isoformat())

        pdf = self.client.get("/api/reports/hours.pdf", headers=self.auth(), query_string={
            "from": self.day.isoformat(), "to": nxt.isoformat(), "user_id": night.id})
        self.assertEqual(pdf.status_code, 200)
        self.assertTrue(pdf.data.startswith(b"%PDF"))

    def test_late_flag_ignores_an_ot_time_in_before_the_shift(self):
        self.department("Ops", start_time="08:00", end_time="17:00")
        user = self.employee("Omar Ops", "Ops")
        self.punch(user, local(self.day, 6, 0), "CLOCK_IN", "OT")
        self.punch(user, local(self.day, 7, 50), "CLOCK_OUT", "OT")
        self.punch(user, local(self.day, 9, 0), "CLOCK_IN")
        row = self.daily(self.day)[0]
        self.assertTrue(row["late"])
        self.assertEqual(row["late_minutes"], 45)
        self.assertEqual(row["first_in"], AttendanceEvent.query.filter_by(session="AM").one().to_dict()["timestamp"])


if __name__ == "__main__":
    unittest.main()
