import csv
import io
import re
from collections import defaultdict
from datetime import datetime
from flask import Blueprint, Response, jsonify, request
from sqlalchemy import func

from app.api.attendance_routes import filtered_events_query, parse_day
from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.attendance_event import AttendanceEvent
from app.models.audit_log import AuditLog
from app.models.face_embedding import FaceEmbedding
from app.models.user import User
from app.services.attendance_service import department_break_times, is_late
from app.services.embedding_index import active_engine, model_filter
from app.utils.auth import load_current_user, require_roles
from app.utils.timezone import now_in_org_tz, org_day_bounds_utc, org_tz, to_org_tz, utcnow

report_bp = Blueprint("reports", __name__)


def _spreadsheet_safe(value) -> str:
    """Prevent user-controlled CSV text from being interpreted as a formula."""
    text = "" if value is None else str(value)
    if re.match(r"^[\t\r\n ]*[=+\-@]", text):
        return "'" + text
    return text


def _break_overlap_seconds(local_start, local_end, break_start: str, break_end: str) -> float:
    """Seconds of [local_start, local_end) that fall inside the department's
    lunch window on local_start's calendar day. This is what makes the
    12pm-1pm break "not included in the time of the employee" whether they
    punch out for lunch (the gap between pairs already excludes it — this
    returns 0 then) or stay clocked in straight through (this subtracts it
    from that one long pair)."""
    bh1, bm1 = (int(x) for x in break_start.split(":"))
    bh2, bm2 = (int(x) for x in break_end.split(":"))
    b_start = local_start.replace(hour=bh1, minute=bm1, second=0, microsecond=0)
    b_end = local_start.replace(hour=bh2, minute=bm2, second=0, microsecond=0)
    if b_end <= b_start:
        return 0.0
    overlap_start, overlap_end = max(local_start, b_start), min(local_end, b_end)
    return max(0.0, (overlap_end - overlap_start).total_seconds())


def _worked_seconds(events: list, dept_break: tuple[str, str], open_until=None) -> float:
    """Sum of CLOCK_IN->CLOCK_OUT pairs (events sorted ascending), minus
    any overlap each pair has with the lunch break window."""
    total, started = 0.0, None
    for e in events:
        if e.event_type == "CLOCK_IN" and started is None:
            started = e.timestamp
        elif e.event_type == "CLOCK_OUT" and started is not None:
            total += _pair_seconds(started, e.timestamp, dept_break)
            started = None
    if started is not None and open_until is not None:
        total += _pair_seconds(started, open_until, dept_break)
    return total


def _pair_seconds(start_utc, end_utc, dept_break: tuple[str, str]) -> float:
    raw = (end_utc - start_utc).total_seconds()
    if raw <= 0:
        return 0.0
    overlap = _break_overlap_seconds(to_org_tz(start_utc), to_org_tz(end_utc), *dept_break)
    return max(0.0, raw - overlap)


@report_bp.get("/today")
@require_roles("ADMIN", "OPERATOR")
def today():
    start, end = org_day_bounds_utc()
    active = User.query.filter(User.is_active.is_(True)).all()
    enrolled_ids = {uid for (uid,) in db.session.query(FaceEmbedding.user_id)
                    .filter(model_filter(active_engine().name)).distinct().all()}
    events = (
        AttendanceEvent.query.filter(AttendanceEvent.timestamp >= start, AttendanceEvent.timestamp < end)
        .order_by(AttendanceEvent.timestamp.asc())
        .all()
    )

    by_user = defaultdict(list)
    for e in events:
        by_user[e.user_id].append(e)

    active_ids = {u.id for u in active}
    present = {uid for uid in by_user if uid in active_ids}
    currently_in = {uid for uid, evs in by_user.items() if uid in active_ids and evs[-1].event_type == "CLOCK_IN"}
    late = {uid for uid, evs in by_user.items() if uid in active_ids and evs[0].event_type == "CLOCK_IN" and is_late(evs[0])}

    tz = org_tz()
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
        "date": now_in_org_tz().date().isoformat(),
        "timezone": str(tz),
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
    if (end_day - start_day).days > 92:
        raise AppError("Date range is limited to 92 days.", 400)
    return start_day, end_day


def _daily_rows(caller, start_day, end_day) -> list[dict]:
    """Per-employee, per-day timesheet: first in, last out, hours worked, late flag."""
    today_local = now_in_org_tz().date()
    events = (
        filtered_events_query(caller)
        .filter(AttendanceEvent.timestamp >= org_day_bounds_utc(start_day)[0],
                AttendanceEvent.timestamp < org_day_bounds_utc(end_day)[1])
        .order_by(AttendanceEvent.timestamp.asc())
        .all()
    )
    grouped = defaultdict(list)
    for e in events:
        grouped[(e.user_id, to_org_tz(e.timestamp).date())].append(e)

    now = utcnow()
    rows = []
    for (user_id, day), evs in sorted(grouped.items(), key=lambda kv: (kv[0][1], kv[1][0].user.full_name)):
        ins = [e for e in evs if e.event_type == "CLOCK_IN"]
        outs = [e for e in evs if e.event_type == "CLOCK_OUT"]
        user = evs[0].user
        dept_break = department_break_times(user)
        reg_events = [e for e in evs if e.session != "OT"]
        ot_events = [e for e in evs if e.session == "OT"]
        open_until = now if day == today_local else None
        hours = round(_worked_seconds(reg_events, dept_break, open_until) / 3600, 2)
        ot_hours = round(_worked_seconds(ot_events, dept_break, open_until) / 3600, 2)
        rows.append({
            "date": day.isoformat(),
            "user_id": user_id,
            "user_name": user.full_name,
            "employee_code": user.employee_code,
            "department": user.department,
            "first_in": ins[0].to_dict()["timestamp"] if ins else None,
            "last_out": outs[-1].to_dict()["timestamp"] if outs else None,
            "hours": hours,
            "ot_hours": ot_hours,
            "total_hours": round(hours + ot_hours, 2),
            "late": bool(ins and is_late(ins[0])),
            "open": evs[-1].event_type == "CLOCK_IN",
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
        })
        p["days_worked"] += 1
        p["hours"] += r["hours"]
        p["ot_hours"] += r["ot_hours"]
        p["late_days"] += r["late"]
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
    it also lists that employee's day-by-day breakdown."""
    from xml.sax.saxutils import escape

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    start_day, end_day = _range_args()
    rows = _daily_rows(load_current_user(), start_day, end_day)
    summary = _hours_summary(rows)

    styles = getSampleStyleSheet()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm,
                            topMargin=15 * mm, bottomMargin=15 * mm, title="Employee hours report")

    def table(data, widths, total_row=False):
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f3f4f6")]),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#d1d5db")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]
        if total_row:
            style.append(("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"))
        t = Table(data, colWidths=widths, repeatRows=1)
        t.setStyle(TableStyle(style))
        return t

    cell = lambda v: Paragraph(escape(str(v or "")), styles["Normal"])
    story = [
        Paragraph("Employee Hours Report", styles["Title"]),
        Paragraph(f"Period: {start_day.isoformat()} to {end_day.isoformat()} | "
                  f"Generated: {now_in_org_tz().strftime('%Y-%m-%d %H:%M')}", styles["Normal"]),
    ]
    if request.args.get("department"):
        story.append(Paragraph(f"Department: {escape(request.args['department'])}", styles["Normal"]))
    story.append(Spacer(1, 6 * mm))

    if summary:
        data = [["Employee", "ID", "Department", "Days", "Regular", "OT", "Total"]]
        for p in summary:
            data.append([cell(p["user_name"]), cell(p["employee_code"]), cell(p["department"]), p["days_worked"],
                         _fmt_hours(p["hours"]), _fmt_hours(p["ot_hours"]), _fmt_hours(p["total_hours"])])
        data.append(["TOTAL", "", "", sum(p["days_worked"] for p in summary),
                     _fmt_hours(sum(p["hours"] for p in summary)),
                     _fmt_hours(sum(p["ot_hours"] for p in summary)),
                     _fmt_hours(sum(p["total_hours"] for p in summary))])
        story.append(table(data, [45 * mm, 20 * mm, 38 * mm, 14 * mm, 22 * mm, 20 * mm, 22 * mm], total_row=True))
    else:
        story.append(Paragraph("No attendance in this period.", styles["Normal"]))

    if request.args.get("user_id") and rows:
        story += [Spacer(1, 8 * mm), Paragraph(f"Daily breakdown - {escape(rows[0]['user_name'])}", styles["Heading2"])]
        detail = [["Date", "Time in", "Time out", "Regular", "OT", "Status"]]
        for r in rows:
            detail.append([r["date"], _local_hhmm(r["first_in"]), _local_hhmm(r["last_out"]),
                           _fmt_hours(r["hours"]), _fmt_hours(r["ot_hours"]),
                           "Late" if r["late"] else "On time" if r["first_in"] else "No clock-in"])
        story.append(table(detail, [28 * mm, 24 * mm, 24 * mm, 28 * mm, 24 * mm, 30 * mm]))

    doc.build(story)
    name = f"hours_{start_day.isoformat()}_{end_day.isoformat()}.pdf"
    return Response(buf.getvalue(), mimetype="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@report_bp.get("/export.csv")
@require_roles("ADMIN", "OPERATOR")
def export_csv():
    caller = load_current_user()
    events = filtered_events_query(caller).order_by(AttendanceEvent.timestamp.asc()).limit(50000).all()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Date", "Time", "Employee ID", "Name", "Department", "Event", "Session", "Late",
                     "Confidence", "Method", "Device", "Notes"])
    for e in events:
        local = to_org_tz(e.timestamp)
        u = e.user
        writer.writerow([
            local.date().isoformat(), local.strftime("%H:%M:%S"), _spreadsheet_safe(u.employee_code), _spreadsheet_safe(u.full_name),
            _spreadsheet_safe(u.department), "Clock in" if e.event_type == "CLOCK_IN" else "Clock out", e.session,
            "Yes" if is_late(e) else "", f"{e.match_score * 100:.1f}%" if e.match_status == "MATCHED" else "",
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
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
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
    logs = AuditLog.query.order_by(AuditLog.created_at.desc()).limit(200).all()
    names = dict(db.session.query(User.id, User.full_name).all())
    return jsonify([{**log.to_dict(), "actor_name": names.get(log.actor_user_id)} for log in logs])
