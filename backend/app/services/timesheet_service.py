"""Timesheets and the live headcount: what the reports say about hours worked.

Pure attendance arithmetic over already-recorded events. The route layer
decides WHICH events a caller may see (it passes in the query); everything
about turning them into work days, hours and flags lives here.
"""
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy.orm import joinedload

from app.extensions import db
from app.models.attendance_event import AttendanceEvent
from app.models.face_embedding import FaceEmbedding
from app.models.user import User
from app.services.attendance_service import (
    REGULAR_SESSIONS,
    departments_by_name,
    early_minutes,
    event_work_date,
    event_work_day,
    late_minutes,
    schedule_work_day,
    user_department,
)
from app.services.embedding_index import active_engine, model_filter
from app.utils.timezone import org_day_bounds_utc, org_tz, to_naive_utc, to_org_tz, utcnow


def break_overlap_seconds(local_start, local_end, break_window) -> float:
    """Seconds of [local_start, local_end) inside the work day's unpaid
    break. `break_window` is the (start, end) org-local datetimes from
    WorkDay.break_window, already anchored on the right calendar day, so a
    02:00-03:00 break on a 22:00-06:00 shift is the NEXT morning's 02:00.
    This is what keeps the break out of worked time whether the employee
    punches out for it (the gap between pairs already excludes it; this
    returns 0 then) or stays clocked in straight through (this subtracts
    it from that one long pair)."""
    if not break_window:
        return 0.0
    b_start, b_end = break_window
    overlap_start, overlap_end = max(local_start, b_start), min(local_end, b_end)
    return max(0.0, (overlap_end - overlap_start).total_seconds())


def _pair_seconds(start_utc, end_utc, break_window) -> float:
    raw = (end_utc - start_utc).total_seconds()
    if raw <= 0:
        return 0.0
    overlap = break_overlap_seconds(to_org_tz(start_utc), to_org_tz(end_utc), break_window)
    return max(0.0, raw - overlap)


def worked_seconds(events: list, break_window, open_until=None) -> float:
    """Sum of CLOCK_IN->CLOCK_OUT pairs (events sorted ascending), minus
    any overlap each pair has with the work day's break window."""
    total, started = 0.0, None
    for e in events:
        if e.event_type == "CLOCK_IN" and started is None:
            started = e.timestamp
        elif e.event_type == "CLOCK_OUT" and started is not None:
            total += _pair_seconds(started, e.timestamp, break_window)
            started = None
    if started is not None and open_until is not None:
        total += _pair_seconds(started, open_until, break_window)
    return total


def chain_open(events: list) -> bool:
    """Whether the regular chain or the OT chain ends on a time in."""
    regular = [e for e in events if e.session in REGULAR_SESSIONS]
    ot = [e for e in events if e.session not in REGULAR_SESSIONS]
    return any(chain and chain[-1].event_type == "CLOCK_IN" for chain in (regular, ot))


def first_arrival(events: list):
    """The work day's arrival punch: the first regular time in (an OT time
    in before the shift is not the arrival), else the first time in."""
    ins = [e for e in events if e.event_type == "CLOCK_IN"]
    regular = [e for e in ins if e.session in REGULAR_SESSIONS]
    return (regular or ins or [None])[0]


def day_late(events: list) -> int | None:
    """Minutes late for this work day (None = on time / no schedule). The
    stamped lateness lives on the first regular time in; legacy rows are
    judged on that same punch."""
    arrival = first_arrival(events)
    if arrival is None or arrival.session not in REGULAR_SESSIONS:
        return None
    return late_minutes(arrival)


def counts_as_employee(user: User) -> bool:
    """Headcount is people who clock in. An admin or operator login with no employee ID, and a kiosk tablet's device
    account, never clock in, so they must not show up as 'not yet in' every day."""
    return user.role != "KIOSK" and bool(user.employee_code or user.role == "STAFF")


# --- live headcount ------------------------------------------------------------

def live_headcount() -> dict:
    """
    Live headcount. present / late / currently-in are judged per employee
    on their CURRENT work day, not the calendar day: a night worker who
    timed in at 22:00 yesterday is "currently in" at 03:00 today, and still
    counts as present after their 06:00 time out. The hourly chart and
    events_today stay on the calendar day (they describe the clock).
    """
    now = utcnow()
    now_local = to_org_tz(now)
    start, end = org_day_bounds_utc()
    active = [u for u in User.query.filter(User.is_active.is_(True)).all() if counts_as_employee(u)]
    active_ids = {u.id for u in active}
    enrolled_ids = {uid for (uid,) in db.session.query(FaceEmbedding.user_id)
                    .filter(model_filter(active_engine().name)).distinct().all()}

    # Every work day that can contain "now" started less than 48h ago.
    recent = (
        AttendanceEvent.query.filter(AttendanceEvent.timestamp >= min(start, now - timedelta(hours=48)),
                                     AttendanceEvent.timestamp < max(end, now + timedelta(minutes=1)))
        .options(joinedload(AttendanceEvent.user))
        .order_by(AttendanceEvent.timestamp.asc())
        .all()
    )
    by_user = defaultdict(list)
    for e in recent:
        if e.user_id in active_ids:
            by_user[e.user_id].append(e)

    depts = departments_by_name()
    users = {u.id: u for u in active}
    present, currently_in, late = set(), set(), set()
    for uid, evs in by_user.items():
        user = users[uid]
        dept = user_department(user, depts)
        past = [e for e in evs if e.timestamp <= now] or evs
        work_day = event_work_day(past[-1], dept)
        if not work_day.contains(now_local):
            work_day = schedule_work_day(user, now_local, dept)
        day_events = [e for e in evs
                      if event_work_date(e, dept) == work_day.work_date
                      and work_day.contains(to_org_tz(e.timestamp))]
        if not day_events:
            continue
        present.add(uid)
        if chain_open(day_events):
            currently_in.add(uid)
        if day_late(day_events) is not None:
            late.add(uid)

    events = [e for e in recent if start <= e.timestamp < end]
    hourly = {h: {"hour": h, "clock_in": 0, "clock_out": 0} for h in range(24)}
    for e in events:
        h = to_org_tz(e.timestamp).hour
        hourly[h]["clock_in" if e.event_type == "CLOCK_IN" else "clock_out"] += 1

    departments = defaultdict(lambda: {"total": 0, "present": 0})
    for u in active:
        d = departments[u.department or "Unassigned"]
        d["total"] += 1
        d["present"] += u.id in present

    return {
        "date": now_local.date().isoformat(),
        "timezone": str(org_tz()),
        "total_employees": len(active),
        "enrolled": len(active_ids & enrolled_ids),
        "present": len(present),
        "currently_in": len(currently_in),
        "late": len(late),
        "absent": len(active_ids - present),
        "events_today": len(events),
        "hourly": [hourly[h] for h in range(24)],
        "departments": [{"department": k, **v} for k, v in sorted(departments.items())],
    }


# --- timesheets ----------------------------------------------------------------

def _open_until(work_day, now, now_local):
    """Where an unfinished shift stops accruing hours. While the work day is
    still running an open shift keeps accruing; once the scheduled end has passed it is
    credited up to that end (not dropped), until the person punches out. Only after the work day has closed is
    a shift without a time out "missed": then it earns nothing until an admin corrects it."""
    if not work_day.contains(now_local):
        return None
    if work_day.end_dt is not None and now_local >= work_day.end_dt:
        return to_naive_utc(work_day.end_dt)
    return now


def _day_row(day: date, user, evs: list, dept, now, now_local) -> dict:
    # The schedule the day was worked under: stamped on its events
    # (legacy rows: derived from the current schedule).
    arrival = first_arrival(evs)
    work_day = event_work_day(arrival or evs[0], dept)
    break_window = work_day.break_window
    reg_events = [e for e in evs if e.session in REGULAR_SESSIONS]
    ot_events = [e for e in evs if e.session not in REGULAR_SESSIONS]
    open_until = _open_until(work_day, now, now_local)
    hours = round(worked_seconds(reg_events, break_window, open_until) / 3600, 2)
    ot_hours = round(worked_seconds(ot_events, break_window, open_until) / 3600, 2)
    outs = [e for e in evs if e.event_type == "CLOCK_OUT"]
    regular_outs = [e for e in reg_events if e.event_type == "CLOCK_OUT"]
    late_by = day_late(evs)
    early_by = early_minutes(regular_outs[-1]) if regular_outs else None
    is_open = chain_open(evs)
    return {
        "date": day.isoformat(),
        "work_date": day.isoformat(),
        "user_id": user.id,
        "user_name": user.full_name,
        "employee_code": user.employee_code,
        "department": user.department,
        "scheduled_start": work_day.scheduled_start,
        "scheduled_end": work_day.scheduled_end,
        "first_in": arrival.to_dict()["timestamp"] if arrival else None,
        "last_out": outs[-1].to_dict()["timestamp"] if outs else None,
        "hours": hours,
        "ot_hours": ot_hours,
        "total_hours": round(hours + ot_hours, 2),
        "late": late_by is not None,
        "late_minutes": late_by,
        "early_leave": early_by is not None,
        "early_minutes": early_by,
        "open": is_open,
        "no_time_out": is_open and open_until is None,
        "events": len(evs),
    }


def daily_rows(events_query, start_day: date, end_day: date) -> list[dict]:
    """
    Per-employee, per-WORK-DAY timesheet: first in, last out, hours worked,
    late flag. Rows are keyed by work_date (the date the shift started), so
    a 22:00-06:00 shift is one row with ~7h, not two half-rows with 0h.
    Events are fetched with a day of slack either side (a work day can
    start the previous evening or end the next morning), then kept only if
    their work_date is inside the range.

    `events_query` is the AttendanceEvent query the caller may see, with no
    date window applied.
    """
    now = utcnow()
    now_local = to_org_tz(now)
    events = (
        events_query.options(joinedload(AttendanceEvent.user))
        .filter(AttendanceEvent.timestamp >= org_day_bounds_utc(start_day - timedelta(days=1))[0],
                AttendanceEvent.timestamp < org_day_bounds_utc(end_day + timedelta(days=1))[1])
        .order_by(AttendanceEvent.timestamp.asc())
        .all()
    )
    depts = departments_by_name()
    grouped = defaultdict(list)
    for e in events:
        if e.user is None:
            continue
        day = event_work_date(e, user_department(e.user, depts))
        if start_day <= day <= end_day:
            grouped[(e.user_id, day)].append(e)

    ordered = sorted(grouped.items(), key=lambda kv: (kv[0][1], kv[1][0].user.full_name.lower()))
    return [_day_row(day, evs[0].user, evs, user_department(evs[0].user, depts), now, now_local)
            for (_user_id, day), evs in ordered]


def hours_summary(rows: list[dict]) -> list[dict]:
    """Collapse per-day rows into one total per employee."""
    people: dict[str, dict] = {}
    for r in rows:
        p = people.setdefault(r["user_id"], {
            "user_id": r["user_id"], "user_name": r["user_name"], "employee_code": r["employee_code"],
            "department": r["department"], "days_worked": 0, "hours": 0.0, "ot_hours": 0.0, "late_days": 0,
            "days_without_time_out": 0,
        })
        p["days_worked"] += 1
        p["hours"] += r["hours"]
        p["ot_hours"] += r["ot_hours"]
        p["late_days"] += r["late"]
        p["days_without_time_out"] += bool(r.get("no_time_out"))
    out = []
    for p in sorted(people.values(), key=lambda x: x["user_name"].lower()):
        p["hours"] = round(p["hours"], 2)
        p["ot_hours"] = round(p["ot_hours"], 2)
        p["total_hours"] = round(p["hours"] + p["ot_hours"], 2)
        out.append(p)
    return out
