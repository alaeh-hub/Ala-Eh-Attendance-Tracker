"""Fill the database with believable demo data so every screen has something to show.

    python scripts/demo_data.py                       # 60 employees, 45 days of attendance
    python scripts/demo_data.py --employees 120 --days 90
    python scripts/demo_data.py --reset               # remove the demo data, then exit
    python scripts/demo_data.py --reset --rebuild     # remove it and generate it again

What it creates (all of it clearly marked, so it can be removed without touching anything real):
  * departments, with working hours, a lunch break, job roles, one with rotating shifts and one on an overnight shift
    (a department that already exists is reused as it is, and the differences are reported - see --align-departments);
  * employees with the e-mail domain @demo.test, employee IDs DEMO-0001, DEMO-0002, ... and no portal login.  They have
    no face samples, so they show as "not enrolled" and can never be matched at the kiosk (see below);
  * attendance punches written through the same service the kiosk uses (record_attendance), so sessions, work dates,
    late and early-leave minutes, overtime and open shifts all behave exactly as live data does;
  * a review queue: unmatched, uncertain, spoof-suspected and liveness-failed scans, some already dismissed, plus kept
    frames of matched punches.  The pictures are cartoon placeholders, never real faces;
  * admin activity: corrected and deleted punches, audited manual entries, new and deactivated employees, all in the
    audit log with before/after values like the real screens write them.

What it deliberately does NOT create: face samples.  Recognition is a match between a live face and a stored one, so
invented samples cannot test it - they would only make people look enrolled who can never be recognised.  To try the
kiosk, enrol a real person on the Enroll page and scan them.

Everything it adds is recognisable (see is_demo_user, DEMO_AUDIT_MARKER and DEMO_DEVICE_PREFIX), so --reset removes
exactly that and nothing else.  It never edits or deletes an existing user, department or attendance row, and on a
database other than SQLite it asks for --force first.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import random
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import create_app  # noqa: E402
from app.api.attendance_routes import _snapshot as event_snapshot  # noqa: E402
from app.extensions import db  # noqa: E402
from app.middleware.error_handler import AppError  # noqa: E402
from app.models.attendance_event import AttendanceEvent  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.department import Department  # noqa: E402
from app.models.face_embedding import FaceEmbedding  # noqa: E402
from app.models.scan_snapshot import ScanSnapshot  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.attendance_service import (  # noqa: E402
    AlreadyVerified,
    CooldownActive,
    record_attendance,
    refresh_arrival_lateness,
    restamp_event,
)
from app.services.auth_service import NO_LOGIN_HASH  # noqa: E402
from app.utils.crypto import encrypt_bytes  # noqa: E402
from app.utils.timezone import org_tz, to_naive_utc, utcnow  # noqa: E402

DEMO_DOMAIN = "@demo.test"
CODE_PREFIX = "DEMO-"
# Review snapshots made here carry this device prefix; audit rows carry this marker in their details.
DEMO_DEVICE_PREFIX = "demo-kiosk-"
DEMO_AUDIT_MARKER = '"demo": true'
MAX_EMPLOYEES = 2000
MAX_DAYS = 365

DEPARTMENTS = [
    dict(name="Kitchen", start="08:00", end="17:00", weight=26,
         roles=["Head Cook", "Sous Chef", "Line Cook", "Prep Cook", "Kitchen Helper"]),
    dict(name="Packing", start="07:00", end="16:00", weight=24,
         roles=["Packing Lead", "Packer", "Labeler", "Sealer"]),
    dict(name="Quality Control", start="08:00", end="17:00", weight=10,
         roles=["QC Supervisor", "QC Inspector", "Lab Analyst"]),
    dict(name="Admin Office", start="09:00", end="18:00", weight=10,
         roles=["Office Manager", "Accountant", "HR Officer", "Encoder"]),
    dict(name="Delivery", start=None, end=None, weight=18, shifts=[
        {"name": "Morning", "start_time": "06:00", "end_time": "14:00"},
        {"name": "Midday", "start_time": "10:00", "end_time": "18:00"}],
         roles=["Driver", "Delivery Helper", "Dispatcher"]),
    dict(name="Production Night", start="22:00", end="06:00", weight=12, break_start="02:00", break_end="03:00",
         roles=["Night Supervisor", "Machine Operator", "Cleaner"]),
]

FIRST = ["Maria", "Juan", "Ana", "Jose", "Liza", "Mark", "Grace", "Paolo", "Carla", "Ramon", "Teresa", "Miguel", "Joy",
         "Dennis", "Rhea", "Carlo", "Bea", "Jun", "Marites", "Noel", "Cherry", "Allan", "Joanna", "Rico", "Aileen", "Ben",
         "Kristine", "Edgar", "Lorna", "Jericho", "Mylene", "Arnel", "Fe", "Rommel", "Gina", "Vince", "Shiela", "Alvin",
         "Nora", "Ferdie", "Hazel", "Leo", "Dolly", "Ariel", "Cathy", "Jomar", "Nena", "Raul", "Wilma", "Tonyo"]
LAST = ["Santos", "Reyes", "Cruz", "Bautista", "Garcia", "Mendoza", "Torres", "Flores", "Ramos", "Aquino", "Castillo",
        "Villanueva", "Dela Cruz", "Navarro", "Salazar", "Domingo", "Pascual", "Rivera", "Gonzales", "Lim", "Tan", "Uy",
        "Soriano", "Aguilar", "Manalo", "Valdez", "Mercado", "De Leon", "Padilla", "Evangelista", "Ocampo", "Lacson",
        "Macaraeg", "Bernardo", "Cabrera", "Panganiban", "Alcantara", "Magsaysay", "Dizon", "Robles"]


def hhmm(value: str) -> tuple[int, int]:
    h, m = value.split(":")
    return int(h), int(m)


def at(day: date, hm: str, tz, minutes: float = 0) -> datetime:
    h, m = hhmm(hm)
    return datetime(day.year, day.month, day.day, h, m, tzinfo=tz) + timedelta(minutes=minutes)


# --- what counts as demo data ------------------------------------------------------------------------------------------

def demo_user_clause():
    """SQL for "this is a demo employee": ALL of the markers the generator puts on one. An e-mail ending in
    @demo.test alone is not enough - a real account that happens to use that domain must survive a reset."""
    return db.and_(
        User.email.like(f"%{DEMO_DOMAIN}"),
        User.employee_code.like(f"{CODE_PREFIX}%"),
        User.password_hash == NO_LOGIN_HASH,
        User.role == "STAFF",
    )


def is_demo_user(user: User) -> bool:
    return (
        (user.email or "").endswith(DEMO_DOMAIN)
        and (user.employee_code or "").startswith(CODE_PREFIX)
        and user.password_hash == NO_LOGIN_HASH
        and user.role == "STAFF"
    )


def department_differences(dept: Department, spec: dict) -> list[str]:
    """How an existing department differs from the demo's intended one (empty list = identical)."""
    wanted_shifts = [(s["name"], s["start_time"], s["end_time"]) for s in spec.get("shifts") or []]
    have_shifts = [(s.get("name"), s.get("start_time"), s.get("end_time")) for s in dept.shifts or []]
    checks = [
        ("working hours", (dept.start_time, dept.end_time), (spec["start"], spec["end"])),
        ("rotating shifts", have_shifts, wanted_shifts),
        ("lunch break", (dept.break_start or "12:00", dept.break_end or "13:00"),
         (spec.get("break_start", "12:00"), spec.get("break_end", "13:00"))),
        ("job roles", sorted(dept.roles or []), sorted(spec["roles"])),
    ]
    return [f"{label}: has {have}, demo wants {want}" for label, have, want in checks if have != want]


def admin_actor_id() -> str | None:
    admin = User.query.filter_by(role="ADMIN", is_active=True).order_by(User.created_at).first()
    return admin.id if admin else None


def audit(actor_id: str | None, action: str, target_type: str, target_id: str, details: dict, when: datetime) -> None:
    """An audit row like log_action writes, but dated `when` and marked as demo so --reset can find it."""
    db.session.add(AuditLog(
        actor_user_id=actor_id, action=action, target_type=target_type, target_id=target_id,
        details=json.dumps({**details, "demo": True}, default=str), created_at=when,
    ))


# --- reset -------------------------------------------------------------------------------------------------------------

def reset() -> None:
    demo_ids = [uid for (uid,) in db.session.query(User.id).filter(demo_user_clause()).all()]
    events = snapshots = 0
    snapshots += ScanSnapshot.query.filter(ScanSnapshot.device_id.like(f"{DEMO_DEVICE_PREFIX}%")).delete(synchronize_session=False)
    for i in range(0, len(demo_ids), 200):
        chunk = demo_ids[i:i + 200]
        snapshots += ScanSnapshot.query.filter(ScanSnapshot.user_id.in_(chunk)).delete(synchronize_session=False)
        FaceEmbedding.query.filter(FaceEmbedding.user_id.in_(chunk)).delete(synchronize_session=False)
        events += AttendanceEvent.query.filter(AttendanceEvent.user_id.in_(chunk)).delete(synchronize_session=False)
    audits = AuditLog.query.filter(AuditLog.details.like(f"%{DEMO_AUDIT_MARKER}%")).delete(synchronize_session=False)
    users = 0
    for i in range(0, len(demo_ids), 200):
        users += User.query.filter(User.id.in_(demo_ids[i:i + 200])).delete(synchronize_session=False)
    db.session.commit()
    removed = 0
    for spec in DEPARTMENTS:
        dept = Department.query.filter(db.func.lower(Department.name) == spec["name"].lower()).first()
        # Only a department that still looks exactly like the demo's, and has nobody in it, was ours to remove.
        if dept and not department_differences(dept, spec) and User.query.filter_by(department=dept.name).count() == 0:
            db.session.delete(dept)
            removed += 1
    db.session.commit()
    print(f"Removed {users} demo employees, {events} of their punches, {snapshots} review snapshots, {audits} audit entries "
          f"and {removed} untouched, empty demo departments.")


# --- departments, employees ---------------------------------------------------------------------------------------------

def ensure_departments(align: bool = False) -> tuple[dict[str, dict], list[str]]:
    """The departments to plan against, plus a warning for each existing one that differs from the demo's.

    An existing department is left alone unless `align` is set, in which case its schedule is brought in line with the
    demo's (so the rotating-shift, lunch-break and overnight examples really exist)."""
    config: dict[str, dict] = {}
    warnings: list[str] = []
    for spec in DEPARTMENTS:
        dept = Department.query.filter(db.func.lower(Department.name) == spec["name"].lower()).first()
        created = dept is None
        if created:
            dept = Department(name=spec["name"])
            db.session.add(dept)
        else:
            diffs = department_differences(dept, spec)
            if diffs and not align:
                warnings.append(f"{dept.name} already exists with different settings ({'; '.join(diffs)})")
        if created or (align and department_differences(dept, spec)):
            dept.start_time, dept.end_time = spec["start"], spec["end"]
            dept.has_shifting = bool(spec.get("shifts"))
            dept.break_start, dept.break_end = spec.get("break_start", "12:00"), spec.get("break_end", "13:00")
            dept.shifts = spec.get("shifts") or []
            dept.roles = spec["roles"]
            db.session.commit()
        # Plan against the department as it is in the database, whether or not this run created it.
        config[dept.name] = dict(weight=spec["weight"], roles=dept.roles or spec["roles"], start=dept.start_time, end=dept.end_time,
                                 shifts=dept.shifts, break_start=dept.break_start or "12:00", break_end=dept.break_end or "13:00",
                                 created=created)
    return config, warnings


def next_code_number() -> int:
    numbers = [int(code[len(CODE_PREFIX):]) for (code,) in db.session.query(User.employee_code).filter(User.employee_code.like(f"{CODE_PREFIX}%")).all()
               if code[len(CODE_PREFIX):].isdigit()]
    return max(numbers, default=0) + 1


def make_employees(count: int, rng: random.Random, depts: dict[str, dict], first_day: date) -> list[User]:
    names = list(depts)
    weights = [depts[n]["weight"] for n in names]
    used: set[str] = set()
    users: list[User] = []
    start_index = next_code_number()
    for i in range(count):
        while True:
            first, last = rng.choice(FIRST), rng.choice(LAST)
            email = f"{first}.{last}.{rng.randint(1, 99)}".lower().replace(" ", "") + DEMO_DOMAIN
            if email not in used and not User.query.filter_by(email=email).first():
                used.add(email)
                break
        dept = rng.choices(names, weights)[0]
        users.append(User(
            full_name=f"{first} {last}", email=email, password_hash=NO_LOGIN_HASH, role="STAFF",
            employee_code=f"{CODE_PREFIX}{start_index + i:04d}", department=dept, position=rng.choice(depts[dept]["roles"]),
            phone=f"09{rng.randint(10, 99)} {rng.randint(100, 999)} {rng.randint(1000, 9999)}",
            created_at=utcnow() - timedelta(days=(utcnow().date() - first_day).days + rng.randint(5, 400)),
        ))
    db.session.add_all(users)
    db.session.commit()
    return users


# --- attendance -----------------------------------------------------------------------------------------------------------

class Counter:
    def __init__(self):
        self.punches = 0
        self.skipped = 0
        self.manual = 0
        self.days = 0
        self.manual_events: list[AttendanceEvent] = []
        self.corrected = 0
        self.deleted = 0
        self.audits = 0
        self.snapshots = 0


def punch(user: User, when_local: datetime, now_utc: datetime, rng: random.Random, tally: Counter, *, want=None, session=None,
          manual_note: str | None = None) -> AttendanceEvent | None:
    """Write one punch; returns it, or None if it lies in the future or the service refused it."""
    ts = to_naive_utc(when_local)
    if ts > now_utc:
        return None
    try:
        event = record_attendance(
            user.id, round(rng.uniform(0.66, 0.97), 3) if not manual_note else 1.0, "MANUAL" if manual_note else "MATCHED",
            not manual_note, rng.choice(["kiosk-1", "kiosk-1", "kiosk-2"]) if not manual_note else None,
            event_type=want, session=session, timestamp=ts, notes=manual_note, enforce_cooldown=not manual_note,
        )
    except (AppError, CooldownActive, AlreadyVerified):
        tally.skipped += 1
        return None
    tally.punches += 1
    if manual_note:
        tally.manual += 1
        tally.manual_events.append(event)
    return event


def work_day(user: User, d: date, dept: dict, rng: random.Random, now_utc: datetime, tz, habit: dict, tally: Counter) -> None:
    if dept["shifts"]:
        shift = rng.choice(dept["shifts"])
        start, end = shift["start_time"], shift["end_time"]
    else:
        start, end = dept["start"], dept["end"]
    if not start or not end:
        return
    overnight = hhmm(end) <= hhmm(start)
    start_dt = at(d, start, tz)
    end_dt = at(d + timedelta(days=1) if overnight else d, end, tz)

    late = rng.random() < habit["late_rate"]
    arrive = start_dt + timedelta(minutes=rng.uniform(4, 42) if late else rng.uniform(-20, 2))
    if not punch(user, arrive, now_utc, rng, tally, want="CLOCK_IN"):
        return

    if not overnight and rng.random() < 0.72:  # most people punch out for lunch
        bs, be = dept["break_start"], dept["break_end"]
        out = at(d, bs, tz, rng.uniform(-6, 12))
        back = at(d, be, tz, rng.uniform(-8, 10) + (rng.uniform(12, 30) if rng.random() < 0.08 else 0))
        if arrive < out < back < end_dt:
            if not punch(user, out, now_utc, rng, tally, want="CLOCK_OUT"):
                return
            if not punch(user, back, now_utc, rng, tally, want="CLOCK_IN"):
                return

    roll = rng.random()
    if roll < 0.03:
        return  # forgot to clock out: the shift stays open
    if roll < 0.13:
        leave = end_dt - timedelta(minutes=rng.uniform(12, 70))  # left early
    else:
        leave = end_dt + timedelta(minutes=rng.uniform(-4, 30))
    if roll > 0.99:  # an admin fixes a forgotten time out afterwards
        punch(user, end_dt, now_utc, rng, tally, want="CLOCK_OUT", manual_note="Manual entry: forgot to clock out")
        return
    if not punch(user, leave, now_utc, rng, tally, want="CLOCK_OUT"):
        return

    if rng.random() < 0.07:  # overtime
        ot_in = leave + timedelta(minutes=rng.uniform(5, 20))
        ot_out = ot_in + timedelta(minutes=rng.uniform(60, 170))
        if punch(user, ot_in, now_utc, rng, tally, want="CLOCK_IN", session="OT"):
            punch(user, ot_out, now_utc, rng, tally, want="CLOCK_OUT", session="OT")
    tally.days += 1


# --- admin activity: corrections, deletions, audit history --------------------------------------------------------------

def admin_activity(users: list[User], leavers: list[User], rng: random.Random, now_utc: datetime, actor_id: str | None,
                   tally: Counter) -> None:
    """What an administrator does over weeks, written the way the real screens write it (same restamping, same audit
    rows with before/after values), dated some hours after the punch they concern and never in the future."""
    def later(ts: datetime, hours_low: float = 2, hours_high: float = 40) -> datetime:
        return min(ts + timedelta(hours=rng.uniform(hours_low, hours_high)), now_utc - timedelta(minutes=1))

    # Audited manual entries (the forgotten time outs punch() already wrote).
    for event in tally.manual_events:
        audit(actor_id, "ATTENDANCE_MANUAL_ENTRY", "attendance_event", event.id,
              {"user_id": event.user_id, "reason": (event.notes or "").removeprefix("Manual: "), **event_snapshot(event)},
              later(event.timestamp))
        tally.audits += 1

    ids = [uid for (uid,) in db.session.query(User.id).filter(User.id.in_([u.id for u in users])).all()]
    cutoff = now_utc - timedelta(days=2)
    base = AttendanceEvent.query.filter(AttendanceEvent.user_id.in_(ids), AttendanceEvent.match_status == "MATCHED",
                                        AttendanceEvent.timestamp < cutoff)

    # "The kiosk was down / they were on time": move a late arrival back to the start of the shift.
    late_ins = base.filter(AttendanceEvent.event_type == "CLOCK_IN", AttendanceEvent.late_minutes > 0).all()
    for event in rng.sample(late_ins, min(len(late_ins), max(3, len(users) // 5))):
        before_ts, work_date = event.timestamp, event.work_date
        before = event_snapshot(event)
        minutes_early = (event.late_minutes or 0) + 15 + rng.uniform(0, 8)
        event.timestamp = before_ts - timedelta(minutes=minutes_early)
        event.notes = "Corrected: arrived on time, kiosk queue"
        restamp_event(event)
        db.session.flush()
        refresh_arrival_lateness(event.user_id, work_date)
        audit(actor_id, "ATTENDANCE_CORRECTED", "attendance_event", event.id,
              {"user_id": event.user_id, "before": before, "after": event_snapshot(event)}, later(before_ts))
        tally.corrected += 1
        tally.audits += 1

    # A last time out recorded a few minutes off: corrected to the real leaving time.
    outs = base.filter(AttendanceEvent.event_type == "CLOCK_OUT", AttendanceEvent.session == "PM").all()
    for event in rng.sample(outs, min(len(outs), max(3, len(users) // 6))):
        before_ts = event.timestamp
        before = event_snapshot(event)
        event.timestamp = before_ts + timedelta(minutes=rng.uniform(6, 25))
        event.notes = "Corrected: stayed to finish the batch"
        restamp_event(event)
        db.session.flush()
        audit(actor_id, "ATTENDANCE_CORRECTED", "attendance_event", event.id,
              {"user_id": event.user_id, "before": before, "after": event_snapshot(event)}, later(before_ts))
        tally.corrected += 1
        tally.audits += 1

    # A mistaken scan is deleted outright (the audit row keeps the whole record); the shift is then left without a time out.
    candidates = base.filter(AttendanceEvent.event_type == "CLOCK_OUT", AttendanceEvent.session == "PM").all()
    for event in rng.sample(candidates, min(len(candidates), max(2, len(users) // 12))):
        audit(actor_id, "ATTENDANCE_DELETED", "attendance_event", event.id, event.to_dict(), later(event.timestamp))
        user_id, work_date = event.user_id, event.work_date
        db.session.delete(event)
        db.session.flush()
        refresh_arrival_lateness(user_id, work_date)
        tally.deleted += 1
        tally.audits += 1

    # Joiners and leavers.
    for user in rng.sample(users, min(len(users), 12)):
        audit(actor_id, "USER_CREATED", "user", user.id,
              {"email": user.email, "role": user.role, "employee_code": user.employee_code, "can_login": False},
              user.created_at)
        tally.audits += 1
    for user in leavers:
        audit(actor_id, "USER_DEACTIVATED", "user", user.id, {}, now_utc - timedelta(days=rng.randint(1, 20)))
        tally.audits += 1
    db.session.commit()


# --- review queue -------------------------------------------------------------------------------------------------------------

def placeholder_frame(rng: random.Random, caption: str, *, screen: bool = False) -> bytes:
    """A cartoon stand-in for a kiosk frame (a head-and-shoulders silhouette on a gradient). Never a real face."""
    import cv2
    import numpy as np

    h, w = 240, 320
    top, bottom = np.array([rng.randint(40, 90), rng.randint(40, 80), rng.randint(40, 70)]), np.array([rng.randint(90, 150)] * 3)
    img = (top + (bottom - top) * np.linspace(0, 1, h)[:, None, None]).astype(np.uint8)
    img = np.repeat(img, w, axis=1)
    skin = (rng.randint(110, 150), rng.randint(140, 175), rng.randint(190, 225))
    cx = w // 2 + rng.randint(-25, 25)
    cv2.ellipse(img, (cx, h + 25), (95, 80), 0, 180, 360, (70, 70, 80), -1)       # shoulders
    cv2.ellipse(img, (cx, h // 2 - 5), (50, 66), 0, 0, 360, skin, -1)              # head
    for dx in (-18, 18):
        cv2.circle(img, (cx + dx, h // 2 - 15), 5, (40, 40, 40), -1)                # eyes
    cv2.ellipse(img, (cx, h // 2 + 22), (16, 8), 0, 0, 180, (60, 60, 120), 2)      # mouth
    if screen:                                                                      # a face held up on a phone screen
        cv2.rectangle(img, (cx - 75, 24), (cx + 75, h - 30), (20, 20, 20), 6)
    noise = np.random.default_rng(rng.randint(0, 10_000)).normal(0, 6, img.shape)
    img = np.clip(img.astype(np.int16) + noise.astype(np.int16), 0, 255).astype(np.uint8)
    cv2.putText(img, "DEMO", (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    cv2.putText(img, caption, (10, h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return buf.tobytes()


def make_review_cases(users: list[User], rng: random.Random, now_utc: datetime, actor_id: str | None, tally: Counter) -> None:
    """(status, how many, already dismissed): a mix of pending and finished cases so every filter of the review page has rows."""
    plan = [("NO_MATCH", 6, 0), ("NO_MATCH", 2, 2), ("LOW_CONFIDENCE", 4, 0), ("LOW_CONFIDENCE", 2, 2), ("AMBIGUOUS_MATCH", 3, 0),
            ("SPOOF_SUSPECTED", 3, 0), ("SPOOF_SUSPECTED", 1, 1), ("LIVENESS_FAILED", 3, 0)]
    created = 0

    def add(status: str, *, user: User | None = None, candidate: User | None = None, event: AttendanceEvent | None = None,
            dismissed: bool = False) -> None:
        nonlocal created
        age = timedelta(hours=rng.uniform(1, 24 * 6))
        when = now_utc - age
        score = {"NO_MATCH": rng.uniform(0.08, 0.28), "LOW_CONFIDENCE": rng.uniform(0.3, 0.4), "AMBIGUOUS_MATCH": rng.uniform(0.45, 0.6),
                 "SPOOF_SUSPECTED": rng.uniform(0.5, 0.8), "LIVENESS_FAILED": rng.uniform(0.62, 0.9), "MATCHED": rng.uniform(0.66, 0.97)}[status]
        snap = ScanSnapshot(
            status=status, score=round(score, 4), device_id=(event.device_id if event else f"{DEMO_DEVICE_PREFIX}{rng.randint(1, 2)}"),
            user_id=user.id if user else None, candidate_user_id=candidate.id if candidate else None, event_id=event.id if event else None,
            runner_up_score=round(score - rng.uniform(0.005, 0.03), 4) if status == "AMBIGUOUS_MATCH" else None,
            spoof_score=round(rng.uniform(0.05, 0.4), 3) if status == "SPOOF_SUSPECTED" else None,
            image=encrypt_bytes(placeholder_frame(rng, status.replace("_", " ").title(), screen=status == "SPOOF_SUSPECTED")),
            created_at=when,
        )
        if dismissed:
            snap.resolution, snap.reviewed_by, snap.reviewed_at = "DISMISSED", actor_id, when + timedelta(hours=rng.uniform(0.5, 6))
        db.session.add(snap)
        db.session.flush()
        if dismissed:
            audit(actor_id, "SNAPSHOT_DISMISSED", "scan_snapshot", snap.id, {}, snap.reviewed_at)
            tally.audits += 1
        created += 1

    for status, count, dismissed in plan:
        for i in range(count):
            person = rng.choice(users)
            hint = rng.choice(users) if status in ("LOW_CONFIDENCE", "AMBIGUOUS_MATCH") else None
            add(status, user=person if status == "LIVENESS_FAILED" else None, candidate=hint, dismissed=i < dismissed)
    # Kept frames of punches that did match, next to the punch they belong to (what "Matched" on the review page lists).
    recent = AttendanceEvent.query.filter(AttendanceEvent.user_id.in_([u.id for u in users]), AttendanceEvent.match_status == "MATCHED",
                                          AttendanceEvent.timestamp > now_utc - timedelta(days=6)).order_by(AttendanceEvent.timestamp.desc()).limit(80).all()
    for event in rng.sample(recent, min(len(recent), 6)):
        add("MATCHED", user=event.user, event=event)
    db.session.commit()
    tally.snapshots = created


# --- main -------------------------------------------------------------------------------------------------------------------------

def bounded_int(name: str, low: int, high: int):
    def parse(text: str) -> int:
        try:
            value = int(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{name} must be a whole number, not {text!r}")
        if not low <= value <= high:
            raise argparse.ArgumentTypeError(f"{name} must be between {low} and {high}, not {value}")
        return value
    return parse


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--employees", type=bounded_int("--employees", 1, MAX_EMPLOYEES), default=60,
                    help=f"how many demo employees to create (1-{MAX_EMPLOYEES}, default 60)")
    ap.add_argument("--days", type=bounded_int("--days", 1, MAX_DAYS), default=45,
                    help=f"days of attendance, ending today (1-{MAX_DAYS}, default 45)")
    ap.add_argument("--seed", type=int, default=7, help="random seed, for repeatable data (default 7)")
    ap.add_argument("--reset", action="store_true", help="remove the demo data and exit (unless --rebuild)")
    ap.add_argument("--rebuild", action="store_true", help="with --reset: generate fresh demo data afterwards")
    ap.add_argument("--align-departments", action="store_true",
                    help="OVERWRITE the schedule, break and roles of existing departments that share a demo name so they match "
                         "the demo's (by default they are reused as they are, and the differences are reported). A department "
                         "changed this way counts as demo data again, so --reset will remove it once it is empty")
    ap.add_argument("--force", action="store_true", help="allow running against a database other than SQLite")
    args = ap.parse_args()
    if args.rebuild and not args.reset:
        ap.error("--rebuild only makes sense together with --reset")

    app = create_app()
    # Ten thousand "attendance recorded" lines would bury the summary (and the app log may be open in the dev server).
    logging.getLogger("app").setLevel(logging.ERROR)
    with app.app_context():
        uri = app.config["SQLALCHEMY_DATABASE_URI"]
        print("Database:", uri.split("@")[-1] if "@" in uri else uri)
        if not uri.startswith("sqlite") and not args.force:
            print("This is not a SQLite database. Pass --force if you really want demo data in it.")
            return 1

        if args.reset:
            reset()
            if not args.rebuild:
                return 0
        elif User.query.filter(demo_user_clause()).first():
            print("Demo data already exists. Run with --reset --rebuild to start over, or --reset to remove it.")
            return 1

        rng = random.Random(args.seed)
        tz = org_tz()
        now_utc = utcnow()
        first_day = (datetime.now(tz) - timedelta(days=args.days)).date()
        actor_id = admin_actor_id()

        depts, warnings = ensure_departments(args.align_departments)
        print(f"Departments: {', '.join(depts)}")
        for warning in warnings:
            print(f"  WARNING: {warning}. The demo uses it as it is; pass --align-departments to match the demo's schedule.")
        users = make_employees(args.employees, rng, depts, first_day)
        print(f"Created {len(users)} employees ({users[0].employee_code} to {users[-1].employee_code}).")

        tally = Counter()
        local_today = datetime.now(tz).date()
        for n, user in enumerate(users, 1):
            dept = depts[user.department]
            habit = {"late_rate": rng.choice([0.03, 0.05, 0.08, 0.12, 0.2]), "absent_rate": rng.choice([0.02, 0.04, 0.07, 0.12])}
            joined = (datetime.now(tz) - timedelta(days=rng.randint(args.days // 2, args.days + 60))).date()
            for offset in range(args.days, -1, -1):
                d = local_today - timedelta(days=offset)
                if d < joined or d.weekday() == 6:  # nobody works Sundays
                    continue
                if d.weekday() == 5 and rng.random() > 0.35:  # Saturdays are a skeleton crew
                    continue
                if rng.random() < habit["absent_rate"] and d != local_today:
                    continue
                if d == local_today and rng.random() < 0.12:
                    continue  # not in yet today
                work_day(user, d, dept, rng, now_utc, tz, habit, tally)
            if n % 10 == 0 or n == len(users):
                print(f"  {n}/{len(users)} employees, {tally.punches} punches so far")

        # A few people have left the company: their history stays, they just can't punch any more.
        leavers = rng.sample(users, max(1, len(users) // 25))
        for user in leavers:
            user.is_active = False
        db.session.commit()

        admin_activity(users, leavers, rng, now_utc, actor_id, tally)
        make_review_cases(users, rng, now_utc, actor_id, tally)

        total = AttendanceEvent.query.count()
        print(f"\nDone: {tally.punches} punches over {args.days} days ({tally.manual} manual entries, {tally.skipped} refused by the "
              f"attendance rules). {total} events in the database, {len(leavers)} employees deactivated.")
        print(f"Admin activity: {tally.corrected} corrected punches, {tally.deleted} deleted punches, {tally.audits} audit entries.")
        print(f"Review queue: {tally.snapshots} scan snapshots (pending, dismissed and matched).")
        if warnings:
            print(f"Note: {len(warnings)} department(s) already existed with different settings and were used as they are.")
        print("Remove it later with:  python scripts/demo_data.py --reset")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
