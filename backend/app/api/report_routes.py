import csv
import io
import re

from flask import Blueprint, Response, jsonify, request
from sqlalchemy import func
from sqlalchemy.orm import joinedload

from app.api.attendance_routes import filtered_events_query, parse_day, parse_page_args
from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.attendance_event import AttendanceEvent
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services import timesheet_service
from app.services.attendance_service import (
    departments_by_name,
    early_minutes,
    event_work_date,
    late_minutes,
    user_department,
)
from app.utils.auth import load_current_user, require_roles
from app.utils.search import smart_filter
from app.utils.timezone import now_in_org_tz, org_day_bounds_utc, to_org_tz

report_bp = Blueprint("reports", __name__)

MAX_RANGE_DAYS = 91  # inclusive span of 92 days
EXPORT_ROW_LIMIT = 50000


def _spreadsheet_safe(value) -> str:
    """Prevent user-controlled CSV text from being interpreted as a formula."""
    text = "" if value is None else str(value)
    if re.match(r"^[\t\r\n ]*[=+\-@]", text):
        return "'" + text
    return text


@report_bp.get("/today")
@require_roles("ADMIN", "OPERATOR")
def today():
    """Live headcount (see timesheet_service.live_headcount)."""
    return jsonify(timesheet_service.live_headcount())


def _range_args():
    today_local = now_in_org_tz().date()
    start_day = parse_day(request.args.get("from")) or today_local
    end_day = parse_day(request.args.get("to")) or start_day
    if end_day < start_day:
        raise AppError("'to' must be on or after 'from'.", 400)
    if (end_day - start_day).days > MAX_RANGE_DAYS:
        raise AppError("Date range is limited to 92 days.", 400)
    return start_day, end_day


def _daily_rows(caller, start_day, end_day) -> list[dict]:
    """The caller's timesheet rows. Reports window by work day themselves (a
    night shift's time out is on the next calendar day), so no date filter."""
    return timesheet_service.daily_rows(filtered_events_query(caller, apply_dates=False), start_day, end_day)


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
    summary = timesheet_service.hours_summary(_daily_rows(load_current_user(), start_day, end_day))
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


def _pdf_response(pdf: bytes, filename: str) -> Response:
    return Response(pdf, mimetype="application/pdf", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@report_bp.get("/hours.pdf")
@require_roles("ADMIN")
def hours_pdf():
    """PDF of every employee's total hours in the date range. With ?user_id
    it also lists that employee's day-by-day breakdown. Styled like the
    interface (see app/services/pdf_report.py)."""
    from app.services.hours_pdfs import employee_hours_pdf

    start_day, end_day = _range_args()
    rows = _daily_rows(load_current_user(), start_day, end_day)
    pdf = employee_hours_pdf(rows, timesheet_service.hours_summary(rows), start_day, end_day,
                             request.args.get("department") or None, bool(request.args.get("user_id")))
    return _pdf_response(pdf, f"hours_{start_day.isoformat()}_{end_day.isoformat()}.pdf")


@report_bp.get("/hours-summary.pdf")
@require_roles("ADMIN", "OPERATOR")
def hours_summary_pdf():
    """A summary of the hours worked in the date range, for the Records page: per employee, per department and per day.
    It follows ?from / ?to (default: today; at most 92 days), ?department and ?q (a name or employee ID contains).
    Not a punch log: the clock-ins and outs themselves are in the Scan log tab and the CSV export."""
    from app.services.hours_pdfs import hours_summary_pdf as build_pdf

    start_day, end_day = _range_args()
    rows = _daily_rows(load_current_user(), start_day, end_day)
    q = (request.args.get("q") or "").strip()
    if q:
        # The same smart search the Records page applies on screen, so the PDF lists exactly the rows you were looking at.
        rows = smart_filter(rows, q, lambda r: (r["user_name"], r["employee_code"], r["department"]), rank=False)
    pdf = build_pdf(rows, timesheet_service.hours_summary(rows), start_day, end_day,
                    request.args.get("department") or None, q)
    return _pdf_response(pdf, f"hours-summary_{start_day.isoformat()}_{end_day.isoformat()}.pdf")


@report_bp.get("/export.csv")
@require_roles("ADMIN", "OPERATOR")
def export_csv():
    caller = load_current_user()
    start_day, end_day = parse_day(request.args.get("from")), parse_day(request.args.get("to"))
    if start_day and end_day and (end_day - start_day).days > MAX_RANGE_DAYS:
        raise AppError("Date range is limited to 92 days.", 400)
    query = filtered_events_query(caller).options(joinedload(AttendanceEvent.user)).order_by(AttendanceEvent.timestamp.asc())
    total = query.order_by(None).count()
    truncated = total > EXPORT_ROW_LIMIT
    events = query.limit(EXPORT_ROW_LIMIT).all()
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
        "\ufeff" + buf.getvalue(),  # BOM so Excel opens UTF-8 names correctly
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
