import csv
import io
import re
from collections import defaultdict
from datetime import datetime, timedelta
from flask import Blueprint, Response, jsonify, request
from sqlalchemy import func
from sqlalchemy.orm import joinedload

from app.api.attendance_routes import filtered_events_query, parse_day, parse_page_args
from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.attendance_event import AttendanceEvent
from app.models.audit_log import AuditLog
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
from app.utils.auth import load_current_user, require_roles
from app.utils.ratelimit import rate_limit, user_key
from app.utils.search import smart_filter
from app.utils.timezone import now_in_org_tz, org_day_bounds_utc, org_tz, to_naive_utc, to_org_tz, utcnow

report_bp = Blueprint("reports", __name__)


def _spreadsheet_safe(value) -> str:
    """Prevent user-controlled CSV text from being interpreted as a formula."""
    text = "" if value is None else str(value)
    if re.match(r"^[\t\r\n ]*[=+\-@]", text):
        return "'" + text
    return text


def _break_overlap_seconds(local_start, local_end, break_window) -> float:
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


def _worked_seconds(events: list, break_window, open_until=None) -> float:
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


def _pair_seconds(start_utc, end_utc, break_window) -> float:
    raw = (end_utc - start_utc).total_seconds()
    if raw <= 0:
        return 0.0
    overlap = _break_overlap_seconds(to_org_tz(start_utc), to_org_tz(end_utc), break_window)
    return max(0.0, raw - overlap)


def _chain_open(events: list) -> bool:
    """Whether the regular chain or the OT chain ends on a time in."""
    regular = [e for e in events if e.session in REGULAR_SESSIONS]
    ot = [e for e in events if e.session not in REGULAR_SESSIONS]
    return any(chain and chain[-1].event_type == "CLOCK_IN" for chain in (regular, ot))


def _first_arrival(events: list):
    """The work day's arrival punch: the first regular time in (an OT time
    in before the shift is not the arrival), else the first time in."""
    ins = [e for e in events if e.event_type == "CLOCK_IN"]
    regular = [e for e in ins if e.session in REGULAR_SESSIONS]
    return (regular or ins or [None])[0]


def _day_late(events: list) -> int | None:
    """Minutes late for this work day (None = on time / no schedule). The
    stamped lateness lives on the first regular time in; legacy rows are
    judged on that same punch."""
    arrival = _first_arrival(events)
    if arrival is None or arrival.session not in REGULAR_SESSIONS:
        return None
    return late_minutes(arrival)


def _counts_as_employee(user: User) -> bool:
    """Headcount is people who clock in. An admin or operator login with no employee ID, and a kiosk tablet's device
    account, never clock in, so they must not show up as 'not yet in' every day."""
    return user.role != "KIOSK" and bool(user.employee_code or user.role == "STAFF")


@report_bp.get("/today")
@require_roles("ADMIN", "OPERATOR")
def today():
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
    active = [u for u in User.query.filter(User.is_active.is_(True)).all() if _counts_as_employee(u)]
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
        if _chain_open(day_events):
            currently_in.add(uid)
        if _day_late(day_events) is not None:
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

    return jsonify({
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
    })


def _range_args():
    today_local = now_in_org_tz().date()
    start_day = parse_day(request.args.get("from")) or today_local
    end_day = parse_day(request.args.get("to")) or start_day
    if end_day < start_day:
        raise AppError("'to' must be on or after 'from'.", 400)
    if (end_day - start_day).days > 91:
        raise AppError("Date range is limited to 92 days.", 400)
    return start_day, end_day


def _daily_rows(caller, start_day, end_day) -> list[dict]:
    """
    Per-employee, per-WORK-DAY timesheet: first in, last out, hours worked,
    late flag. Rows are keyed by work_date (the date the shift started), so
    a 22:00-06:00 shift is one row with ~7h, not two half-rows with 0h.
    Events are fetched with a day of slack either side (a work day can
    start the previous evening or end the next morning), then kept only if
    their work_date is inside the range.
    """
    now = utcnow()
    now_local = to_org_tz(now)
    events = (
        filtered_events_query(caller, apply_dates=False).options(joinedload(AttendanceEvent.user))
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

    rows = []
    for (user_id, day), evs in sorted(grouped.items(), key=lambda kv: (kv[0][1], kv[1][0].user.full_name.lower())):
        user = evs[0].user
        dept = user_department(user, depts)
        # The schedule the day was worked under: stamped on its events
        # (legacy rows: derived from the current schedule).
        arrival = _first_arrival(evs)
        work_day = event_work_day(arrival or evs[0], dept)
        break_window = work_day.break_window
        reg_events = [e for e in evs if e.session in REGULAR_SESSIONS]
        ot_events = [e for e in evs if e.session not in REGULAR_SESSIONS]
        # While the work day is still running an open shift keeps accruing; once the scheduled end has passed it is
        # credited up to that end (not dropped), until the person punches out. Only after the work day has closed is
        # a shift without a time out "missed": then it earns nothing until an admin corrects it.
        in_window = work_day.contains(now_local)
        if not in_window:
            open_until = None
        elif work_day.end_dt is not None and now_local >= work_day.end_dt:
            open_until = to_naive_utc(work_day.end_dt)
        else:
            open_until = now
        work_day_active = in_window
        hours = round(_worked_seconds(reg_events, break_window, open_until) / 3600, 2)
        ot_hours = round(_worked_seconds(ot_events, break_window, open_until) / 3600, 2)
        outs = [e for e in evs if e.event_type == "CLOCK_OUT"]
        regular_outs = [e for e in reg_events if e.event_type == "CLOCK_OUT"]
        late_by = _day_late(evs)
        early_by = early_minutes(regular_outs[-1]) if regular_outs else None
        rows.append({
            "date": day.isoformat(),
            "work_date": day.isoformat(),
            "user_id": user_id,
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
            "open": _chain_open(evs),
            "no_time_out": _chain_open(evs) and not work_day_active,
            "events": len(evs),
        })
    return rows


def _hours_summary(rows: list[dict]) -> list[dict]:
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


@report_bp.get("/daily")
@require_roles("ADMIN", "OPERATOR")
def daily():
    start_day, end_day = _range_args()
    return jsonify(_daily_rows(load_current_user(), start_day, end_day))


@report_bp.get("/hours-summary")
@require_roles("ADMIN")
def hours_summary():
    """Total hours per employee between ?from and ?to (optionally one ?user_id / ?department)."""
    start_day, end_day = _range_args()
    summary = _hours_summary(_daily_rows(load_current_user(), start_day, end_day))
    return jsonify({
        "from": start_day.isoformat(),
        "to": end_day.isoformat(),
        "employees": summary,
        "totals": {
            "employees": len(summary),
            "hours": round(sum(p["hours"] for p in summary), 2),
            "ot_hours": round(sum(p["ot_hours"] for p in summary), 2),
            "total_hours": round(sum(p["total_hours"] for p in summary), 2),
        },
    })


def _fmt_hours(h: float) -> str:
    whole = int(h)
    minutes = int(round((h - whole) * 60))
    if minutes == 60:
        whole, minutes = whole + 1, 0
    return f"{whole}h {minutes:02d}m"


def _local_hhmm(iso: str | None) -> str:
    if not iso:
        return "-"
    return to_org_tz(datetime.fromisoformat(iso.rstrip("Z"))).strftime("%H:%M")


@report_bp.get("/hours.pdf")
@require_roles("ADMIN")
def hours_pdf():
    """PDF of every employee's total hours in the date range. With ?user_id
    it also lists that employee's day-by-day breakdown. Styled like the
    interface (see app/services/pdf_report.py)."""
    from app.services.pdf_report import Section, Stat, render_report

    start_day, end_day = _range_args()
    rows = _daily_rows(load_current_user(), start_day, end_day)
    summary = _hours_summary(rows)
    missed_timeouts = sum(p["days_without_time_out"] for p in summary)

    meta = [f"period    {start_day.isoformat()} to {end_day.isoformat()}"]
    if request.args.get("department"):
        meta.append(f"dept      {request.args['department']}")
    meta.append(f"created   {now_in_org_tz().strftime('%Y-%m-%d %H:%M')}")

    sections = []
    stats = []
    if summary:
        data = [[p["user_name"], p["employee_code"], p["department"], p["days_worked"],
                 _fmt_hours(p["hours"]), _fmt_hours(p["ot_hours"]), _fmt_hours(p["total_hours"])] for p in summary]
        data.append(["Total", "", "", sum(p["days_worked"] for p in summary),
                     _fmt_hours(sum(p["hours"] for p in summary)),
                     _fmt_hours(sum(p["ot_hours"] for p in summary)),
                     _fmt_hours(sum(p["total_hours"] for p in summary))])
        sections.append(Section("Hours by employee", ["EMPLOYEE", "ID", "DEPARTMENT", "DAYS", "REGULAR", "OT", "TOTAL"], data,
                                [48, 20, 38, 14, 22, 16, 22], total_row=True, align_right=(3, 4, 5, 6)))
        stats = [Stat("Employees", str(len(summary)), accent=True),
                 Stat("Regular hours", _fmt_hours(sum(p["hours"] for p in summary))),
                 Stat("OT hours", _fmt_hours(sum(p["ot_hours"] for p in summary))),
                 Stat("Total hours", _fmt_hours(sum(p["total_hours"] for p in summary))),
                 Stat("Missing time-outs", str(missed_timeouts))]

    if request.args.get("user_id") and rows:
        detail = [[r["date"], _local_hhmm(r["first_in"]), _local_hhmm(r["last_out"]),
                   _fmt_hours(r["hours"]), _fmt_hours(r["ot_hours"]),
                   "No time out" if r.get("no_time_out") else
                   "Late" if r["late"] else "On time" if r["first_in"] else "No clock-in"] for r in rows]
        sections.append(Section(f"Daily breakdown: {rows[0]['user_name']}", ["DATE", "TIME IN", "TIME OUT", "REGULAR", "OT", "STATUS"],
                                detail, [30, 26, 26, 28, 24, 32], align_right=(3, 4)))

    pdf = render_report(title="Employee hours", slug="hours-report", meta=meta, stats=stats, sections=sections,
                        empty_message="No attendance in this period.",
                        notes=["Days with a missed time-out are flagged and excluded from hours until corrected."] if summary else (),
                        footer_note="Ala Eh! attendance report")
    name = f"hours_{start_day.isoformat()}_{end_day.isoformat()}.pdf"
    return Response(pdf, mimetype="application/pdf", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@report_bp.get("/hours-summary.pdf")
@require_roles("ADMIN", "OPERATOR")
def hours_summary_pdf():
    """A summary of the hours worked in the date range, for the Records page: per employee, per department and per day.
    It follows ?from / ?to (default: today; at most 92 days), ?department and ?q (a name or employee ID contains).
    Not a punch log: the clock-ins and outs themselves are in the Scan log tab and the CSV export."""
    from app.services.pdf_report import Section, Stat, render_report

    start_day, end_day = _range_args()
    rows = _daily_rows(load_current_user(), start_day, end_day)
    q = (request.args.get("q") or "").strip()
    if q:
        # The same smart search the Records page applies on screen, so the PDF lists exactly the rows you were looking at.
        rows = smart_filter(rows, q, lambda r: (r["user_name"], r["employee_code"], r["department"]), rank=False)
    summary = _hours_summary(rows)

    regular = sum(p["hours"] for p in summary)
    overtime = sum(p["ot_hours"] for p in summary)
    late_days = sum(p["late_days"] for p in summary)
    missed_timeouts = sum(p["days_without_time_out"] for p in summary)
    span = (end_day - start_day).days + 1
    period = start_day.isoformat() if span == 1 else f"{start_day.isoformat()} to {end_day.isoformat()}"
    meta = [f"period    {period}  ({span} day{'s' if span != 1 else ''})",
            f"dept      {request.args['department']}" if request.args.get("department") else "dept      all departments"]
    if q:
        meta.append(f"search    {request.args['q'].strip()}")
    meta.append(f"created   {now_in_org_tz().strftime('%Y-%m-%d %H:%M')}")

    stats = [Stat("Employees", str(len(summary))), Stat("Total hours", _fmt_hours(regular + overtime), accent=True),
             Stat("Regular", _fmt_hours(regular)), Stat("Overtime", _fmt_hours(overtime)), Stat("Late days", str(late_days)),
             Stat("Missing time-outs", str(missed_timeouts))]

    by_day: dict[str, float] = defaultdict(float)
    for r in rows:
        by_day[r["date"]] += r["total_hours"]
    chart = None
    if summary and 1 < span <= 62:
        days = [start_day + timedelta(days=i) for i in range(span)]
        chart = [(d.strftime("%m-%d"), round(by_day.get(d.isoformat(), 0.0), 2)) for d in days]

    sections = []
    departments: dict[str, dict] = {}
    for p in summary:
        d = departments.setdefault(p["department"] or "Unassigned", {"people": 0, "days": 0, "hours": 0.0, "ot": 0.0})
        d["people"] += 1
        d["days"] += p["days_worked"]
        d["hours"] += p["hours"]
        d["ot"] += p["ot_hours"]
    if len(departments) > 1:
        dept_rows = [[name, d["people"], d["days"], _fmt_hours(d["hours"]), _fmt_hours(d["ot"]), _fmt_hours(d["hours"] + d["ot"]),
                      _fmt_hours((d["hours"] + d["ot"]) / d["people"])]
                     for name, d in sorted(departments.items(), key=lambda kv: -(kv[1]["hours"] + kv[1]["ot"]))]
        sections.append(Section("Hours by department", ["DEPARTMENT", "PEOPLE", "DAYS", "REGULAR", "OT", "TOTAL", "PER PERSON"], dept_rows,
                                [46, 17, 16, 26, 22, 26, 27], align_right=(1, 2, 3, 4, 5, 6)))
    if summary:
        emp_rows = [[p["user_name"], p["employee_code"] or "", p["department"] or "", p["days_worked"], _fmt_hours(p["hours"]),
                     _fmt_hours(p["ot_hours"]), _fmt_hours(p["total_hours"]), p["late_days"]] for p in summary]
        emp_rows.append(["Total", "", "", "", _fmt_hours(regular), _fmt_hours(overtime), _fmt_hours(regular + overtime), late_days])
        sections.append(Section("Hours by employee", ["EMPLOYEE", "ID", "DEPARTMENT", "DAYS", "REGULAR", "OT", "TOTAL", "LATE"], emp_rows,
                                [42, 22, 31, 12, 22, 17, 22, 12], total_row=True, align_right=(3, 4, 5, 6, 7)))

    pdf = render_report(title="Hours summary", slug="hours-summary", meta=meta, stats=stats if summary else (), sections=sections,
                        empty_message="No hours were recorded in this period.", chart=chart, chart_title="Hours per day",
                        notes=["Unpaid break time is not counted. A shift that is still open counts up to now.",
                               "Days with a missed time-out are flagged and excluded from hours until corrected."] if summary else (),
                        footer_note="Ala Eh! hours summary")
    name = f"hours-summary_{start_day.isoformat()}_{end_day.isoformat()}.pdf"
    return Response(pdf, mimetype="application/pdf", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@report_bp.get("/export.csv")
@require_roles("ADMIN", "OPERATOR")
def export_csv():
    caller = load_current_user()
    start_day, end_day = parse_day(request.args.get("from")), parse_day(request.args.get("to"))
    if start_day and end_day and (end_day - start_day).days > 91:
        raise AppError("Date range is limited to 92 days.", 400)
    query = filtered_events_query(caller).options(joinedload(AttendanceEvent.user)).order_by(AttendanceEvent.timestamp.asc())
    total = query.order_by(None).count()
    truncated = total > 50000
    events = query.limit(50000).all()
    buf = io.StringIO()
    writer = csv.writer(buf)
    # "Work date" is the shift's day: a night shift's 06:00 time out
    # carries the previous date. Late/early come from the values stamped
    # when the punch was recorded.
    writer.writerow(["Date", "Time", "Employee ID", "Name", "Department", "Event", "Session", "Late",
                     "Work date", "Late (min)", "Early leave (min)",
                     "Confidence", "Method", "Device", "Notes"])
    depts = departments_by_name()
    for e in events:
        local = to_org_tz(e.timestamp)
        u = e.user
        lm, em = late_minutes(e), early_minutes(e)
        writer.writerow([
            local.date().isoformat(), local.strftime("%H:%M:%S"), _spreadsheet_safe(u.employee_code), _spreadsheet_safe(u.full_name),
            _spreadsheet_safe(u.department), "Clock in" if e.event_type == "CLOCK_IN" else "Clock out", e.session,
            "Yes" if lm is not None else "", event_work_date(e, user_department(u, depts)).isoformat(),
            lm if lm is not None else "", em if em is not None else "",
            f"{e.match_score * 100:.1f}%" if e.match_status == "MATCHED" else "",
            e.match_status, _spreadsheet_safe(e.device_id), _spreadsheet_safe(e.notes),
        ])
    # Query parameters are user-controlled and must not be copied verbatim
    # into a response header.
    safe_from = re.sub(r"[^0-9A-Za-z_-]", "", request.args.get("from") or "all")[:20] or "all"
    safe_to = re.sub(r"[^0-9A-Za-z_-]", "", request.args.get("to") or "all")[:20] or "all"
    name = f"attendance_{safe_from}_{safe_to}.csv"
    return Response(
        "﻿" + buf.getvalue(),  # BOM so Excel opens UTF-8 names correctly
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{name}"',
                 "X-Total-Count": str(total), "X-Export-Truncated": "true" if truncated else "false"},
    )


@report_bp.get("/summary")
@require_roles("ADMIN", "OPERATOR")
def summary():
    rows = (
        db.session.query(User.full_name, func.count(AttendanceEvent.id))
        .join(AttendanceEvent, AttendanceEvent.user_id == User.id)
        .group_by(User.id, User.full_name)
        .all()
    )
    return jsonify([{"full_name": name, "event_count": count} for name, count in rows])


@report_bp.get("/audit")
@require_roles("ADMIN")
def audit():
    """
    Audit trail, newest first. ?limit (default 200, max 1000) / ?offset
    page through it; ?from / ?to (org-local YYYY-MM-DD, inclusive) and
    ?action (exact, case-insensitive) filter it. The body stays a plain
    array; X-Total-Count carries the filtered total for paging.
    """
    limit, offset = parse_page_args(default_limit=200, max_limit=1000)
    start_day, end_day = parse_day(request.args.get("from")), parse_day(request.args.get("to"))
    if start_day and end_day and end_day < start_day:
        raise AppError("'to' must be on or after 'from'.", 400)
    query = AuditLog.query
    if start_day:
        query = query.filter(AuditLog.created_at >= org_day_bounds_utc(start_day)[0])
    if end_day:
        query = query.filter(AuditLog.created_at < org_day_bounds_utc(end_day)[1])
    action = (request.args.get("action") or "").strip()
    if action:
        query = query.filter(func.upper(AuditLog.action) == action.upper()[:80])
    total = query.order_by(None).count()
    logs = query.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).offset(offset).limit(limit).all()
    actor_ids = {log.actor_user_id for log in logs if log.actor_user_id}
    names = dict(db.session.query(User.id, User.full_name).filter(User.id.in_(actor_ids)).all()) if actor_ids else {}
    response = jsonify([{**log.to_dict(), "actor_name": names.get(log.actor_user_id)} for log in logs])
    response.headers["X-Total-Count"] = str(total)
    return response
