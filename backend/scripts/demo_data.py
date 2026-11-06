"""Fill the database with believable demo data so every screen has something to show.

    python scripts/demo_data.py                       # 60 employees, 45 days of attendance
    python scripts/demo_data.py --employees 120 --days 90
    python scripts/demo_data.py --reset               # remove the demo data, then exit
    python scripts/demo_data.py --reset --rebuild     # remove it and generate it again

What it creates (all of it clearly marked, so it can be removed without touching anything real):
  * departments, with working hours, a lunch break, job roles, one with rotating shifts and one on an overnight shift
    (a department is only added if its name is not taken already);
  * employees with the e-mail domain @demo.test and employee IDs DEMO-0001, DEMO-0002, ...  They have no portal login
    and no face samples, so they show as "not enrolled" and can never be matched at the kiosk;
  * attendance punches written through the same service the kiosk uses (record_attendance), so sessions, work dates,
    late and early-leave minutes, overtime and open shifts all behave exactly as live data does.

It never edits or deletes an existing user, department or attendance row, and on a database other than SQLite it asks
for --force first.
"""
from __future__ import annotations

import argparse
import logging
import os
import random
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402
from app.middleware.error_handler import AppError  # noqa: E402
from app.models.attendance_event import AttendanceEvent  # noqa: E402
from app.models.department import Department  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.attendance_service import AlreadyVerified, CooldownActive, record_attendance  # noqa: E402
from app.services.auth_service import NO_LOGIN_HASH  # noqa: E402
from app.utils.timezone import org_tz, to_naive_utc, utcnow  # noqa: E402

DEMO_DOMAIN = "@demo.test"
CODE_PREFIX = "DEMO-"

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


def is_demo_user(user: User) -> bool:
    return (user.email or "").endswith(DEMO_DOMAIN)


def reset() -> None:
    demo_ids = [u.id for u in User.query.filter(User.email.like(f"%{DEMO_DOMAIN}")).all()]
    events = 0
    for i in range(0, len(demo_ids), 200):
        events += AttendanceEvent.query.filter(AttendanceEvent.user_id.in_(demo_ids[i:i + 200])).delete(synchronize_session=False)
    users = User.query.filter(User.email.like(f"%{DEMO_DOMAIN}")).delete(synchronize_session=False)
    db.session.commit()
    names = [d["name"] for d in DEPARTMENTS]
    removed = 0
    for dept in Department.query.filter(Department.name.in_(names)).all():
        if User.query.filter_by(department=dept.name).count() == 0:
            db.session.delete(dept)
            removed += 1
    db.session.commit()
    print(f"Removed {users} demo employees, {events} of their punches and {removed} empty demo departments.")


def ensure_departments() -> dict[str, dict]:
    config: dict[str, dict] = {}
    for spec in DEPARTMENTS:
        dept = Department.query.filter(db.func.lower(Department.name) == spec["name"].lower()).first()
        created = dept is None
        if created:
            dept = Department(name=spec["name"], start_time=spec["start"], end_time=spec["end"], has_shifting=bool(spec.get("shifts")),
                              break_start=spec.get("break_start", "12:00"), break_end=spec.get("break_end", "13:00"))
            dept.shifts = spec.get("shifts") or []
            dept.roles = spec["roles"]
            db.session.add(dept)
            db.session.commit()
        # Plan against the department as it is in the database, whether or not this run created it.
        config[dept.name] = dict(weight=spec["weight"], roles=dept.roles or spec["roles"], start=dept.start_time, end=dept.end_time,
                                 shifts=dept.shifts, break_start=dept.break_start or "12:00", break_end=dept.break_end or "13:00",
                                 created=created)
    return config


def make_employees(count: int, rng: random.Random, depts: dict[str, dict], first_day: date) -> list[User]:
    names = list(depts)
    weights = [depts[n]["weight"] for n in names]
    used: set[str] = set()
    users: list[User] = []
    start_index = User.query.filter(User.employee_code.like(f"{CODE_PREFIX}%")).count() + 1
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


class Counter:
    def __init__(self):
        self.punches = 0
        self.skipped = 0
        self.manual = 0
        self.days = 0


def punch(user: User, when_local: datetime, now_utc: datetime, rng: random.Random, tally: Counter, *, want=None, session=None,
          manual_note: str | None = None) -> bool:
    """Write one punch; returns False if it lies in the future or the service refused it."""
    ts = to_naive_utc(when_local)
    if ts > now_utc:
        return False
    try:
        record_attendance(
            user.id, round(rng.uniform(0.66, 0.97), 3) if not manual_note else 1.0, "MANUAL" if manual_note else "MATCHED",
            not manual_note, rng.choice(["kiosk-1", "kiosk-1", "kiosk-2"]) if not manual_note else None,
            event_type=want, session=session, timestamp=ts, notes=manual_note, enforce_cooldown=not manual_note,
        )
    except (AppError, CooldownActive, AlreadyVerified):
        tally.skipped += 1
        return False
    tally.punches += 1
    tally.manual += 1 if manual_note else 0
    return True


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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--employees", type=int, default=60, help="how many demo employees to create (default 60)")
    ap.add_argument("--days", type=int, default=45, help="days of attendance, ending today (default 45)")
    ap.add_argument("--seed", type=int, default=7, help="random seed, for repeatable data (default 7)")
    ap.add_argument("--reset", action="store_true", help="remove the demo data and exit (unless --rebuild)")
    ap.add_argument("--rebuild", action="store_true", help="with --reset: generate fresh demo data afterwards")
    ap.add_argument("--force", action="store_true", help="allow running against a database other than SQLite")
    args = ap.parse_args()

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
        elif User.query.filter(User.email.like(f"%{DEMO_DOMAIN}")).first():
            print("Demo data already exists. Run with --reset --rebuild to start over, or --reset to remove it.")
            return 1

        rng = random.Random(args.seed)
        tz = org_tz()
        now_utc = utcnow()
        today = now_utc.replace(tzinfo=None).date()
        first_day = (datetime.now(tz) - timedelta(days=args.days)).date()

        depts = ensure_departments()
        print(f"Departments: {', '.join(depts)}")
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

        total = AttendanceEvent.query.count()
        print(f"\nDone: {tally.punches} punches over {args.days} days ({tally.manual} manual entries, {tally.skipped} refused by the "
              f"attendance rules). {total} events in the database, {len(leavers)} employees deactivated.")
        print("Remove it later with:  python scripts/demo_data.py --reset")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
