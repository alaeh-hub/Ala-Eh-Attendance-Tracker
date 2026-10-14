from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request

from app.extensions import db, socketio
from app.middleware.error_handler import AppError
from app.models.attendance_event import AttendanceEvent
from app.models.user import User
from app.services.attendance_service import (
    EVENT_TYPES,
    SESSIONS,
    event_payload,
    record_attendance,
    refresh_arrival_lateness,
    restamp_event,
)
from app.utils.audit import log_action
from app.utils.auth import load_current_user, require_roles
from app.utils.timezone import org_day_bounds_utc, parse_api_timestamp, utcnow

# A manual entry or correction may not be dated in the future; this much
# slack absorbs clock skew between the admin's browser and the server.
FUTURE_TOLERANCE = timedelta(minutes=5)

attendance_bp = Blueprint("attendance", __name__)


def parse_day(value: str | None):
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise AppError("Dates must be YYYY-MM-DD.", 400)


def parse_page_args(default_limit: int | None = 50, max_limit: int = 1000) -> tuple[int | None, int]:
    """?limit / ?offset for paginated list endpoints (limit None = no limit)."""
    try:
        raw = request.args.get("limit")
        limit = default_limit if raw in (None, "") else int(raw)
        offset = int(request.args.get("offset") or 0)
    except ValueError:
        raise AppError("limit and offset must be numbers.", 400)
    if limit is not None:
        limit = max(1, min(limit, max_limit))
    return limit, max(0, offset)


def _parse_timestamp(value) -> datetime:
    """Client timestamp -> naive UTC. Naive input is org-local wall time
    (what the admin's form sends). Future times are rejected: attendance
    that hasn't happened yet can't be recorded."""
    try:
        parsed = parse_api_timestamp(value)
    except (TypeError, ValueError):
        raise AppError("Invalid timestamp. Use YYYY-MM-DDTHH:mm:ss (org-local) or ISO-8601 with an offset.", 400)
    if parsed > utcnow() + FUTURE_TOLERANCE:
        raise AppError("The timestamp cannot be in the future.", 400, {"code": "FUTURE_TIMESTAMP"})
    return parsed


def filtered_events_query(caller, apply_dates: bool = True):
    """Shared filters for the list endpoint, CSV export and reports. Reports
    pass apply_dates=False and window by work day themselves (a night
    shift's time out is on the next calendar day)."""
    query = AttendanceEvent.query.join(User, User.id == AttendanceEvent.user_id)
    if caller.role == "STAFF":
        query = query.filter(AttendanceEvent.user_id == caller.id)
    elif request.args.get("user_id"):
        query = query.filter(AttendanceEvent.user_id == request.args["user_id"])

    start_day, end_day = parse_day(request.args.get("from")), parse_day(request.args.get("to"))
    if not apply_dates:
        start_day = end_day = None
    if start_day:
        query = query.filter(AttendanceEvent.timestamp >= org_day_bounds_utc(start_day)[0])
    if end_day:
        query = query.filter(AttendanceEvent.timestamp < org_day_bounds_utc(end_day)[1])
    if request.args.get("department"):
        query = query.filter(User.department == request.args["department"])
    if request.args.get("event_type") in ("CLOCK_IN", "CLOCK_OUT"):
        query = query.filter(AttendanceEvent.event_type == request.args["event_type"])
    if request.args.get("session") in ("AM", "PM", "OT"):
        query = query.filter(AttendanceEvent.session == request.args["session"])
    return query


@attendance_bp.get("")
@require_roles()
def list_attendance():
    """STAFF sees only their own events; ADMIN/OPERATOR can filter by user,
    department and date range. ?limit (default 50, max 1000) and ?offset
    page through the newest-first list; X-Total-Count has the full count."""
    caller = load_current_user()
    limit, offset = parse_page_args(default_limit=50, max_limit=1000)
    query = filtered_events_query(caller)
    total = query.order_by(None).count()
    events = (query.order_by(AttendanceEvent.timestamp.desc(), AttendanceEvent.id.desc())
              .offset(offset).limit(limit).all())
    response = jsonify([event_payload(e) for e in events])
    response.headers["X-Total-Count"] = str(total)
    return response


def _snapshot(event: AttendanceEvent) -> dict:
    """The correctable facts of an event, for before/after audit details."""
    return {
        "event_type": event.event_type,
        "session": event.session,
        "timestamp": event.to_dict()["timestamp"],
        "notes": event.notes,
        "work_date": event.work_date.isoformat() if event.work_date else None,
        "late_minutes": event.late_minutes,
        "early_minutes": event.early_minutes,
    }


@attendance_bp.post("")
@require_roles("ADMIN")
def manual_entry():
    """Admin records an event by hand (e.g. camera down). Always audited.
    A naive timestamp is org-local wall time; without a session the half is
    taken from the employee's break / work day, as for a kiosk scan."""
    caller = load_current_user()
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        raise AppError("A JSON object is required.", 400)
    user_id = data.get("user_id")
    event_type = data.get("event_type")
    session = data.get("session") or None
    reason = data.get("notes") if isinstance(data.get("notes"), str) else ""
    reason = reason.strip()
    if not isinstance(user_id, str) or not user_id or event_type not in EVENT_TYPES:
        raise AppError("user_id and event_type (CLOCK_IN/CLOCK_OUT) are required.", 400)
    if session is not None and session not in SESSIONS:
        raise AppError("session must be AM, PM or OT.", 400)
    if not reason:
        raise AppError("A reason is required for manual entries.", 400)
    if len(reason) > 255:
        raise AppError("The reason must be at most 255 characters.", 400)

    timestamp = _parse_timestamp(data["timestamp"]) if data.get("timestamp") else None

    event = record_attendance(
        user_id=user_id, match_score=0.0, match_status="MANUAL", liveness_passed=False,
        device_id="manual", event_type=event_type, session=session, timestamp=timestamp,
        notes=f"Manual: {reason}"[:255], enforce_cooldown=False,
    )
    log_action(caller.id, "ATTENDANCE_MANUAL_ENTRY", "attendance_event", event.id,
               {"user_id": user_id, "reason": reason, **_snapshot(event)})
    db.session.commit()
    payload = event_payload(event)
    socketio.emit("attendance_event", payload, to="dashboards")
    return jsonify(payload), 201


@attendance_bp.patch("/<event_id>")
@require_roles("ADMIN")
def correct_attendance(event_id):
    """Correct an event's type, session, time and/or notes. The work day
    and late/early minutes are recomputed against the current schedule
    (the admin is deliberately re-judging this punch), and the change is
    audited with before/after values."""
    caller = load_current_user()
    event = db.session.get(AttendanceEvent, event_id)
    if not event:
        raise AppError("Attendance event not found.", 404)

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        raise AppError("A JSON object is required.", 400)
    if not any(k in data for k in ("event_type", "session", "timestamp", "notes")):
        raise AppError("At least one of event_type, session, timestamp or notes is required.", 400)
    if "event_type" in data and data["event_type"] not in EVENT_TYPES:
        raise AppError("event_type must be CLOCK_IN or CLOCK_OUT.", 400)
    if "session" in data and data["session"] not in SESSIONS:
        raise AppError("session must be AM, PM or OT.", 400)
    if "notes" in data and data["notes"] is not None and not isinstance(data["notes"], str):
        raise AppError("notes must be text.", 400)
    new_timestamp = _parse_timestamp(data["timestamp"]) if "timestamp" in data else None

    before = _snapshot(event)
    old_work_date = event.work_date
    if "event_type" in data:
        event.event_type = data["event_type"]
    if "session" in data:
        event.session = data["session"]
    if new_timestamp is not None:
        event.timestamp = new_timestamp
    if "notes" in data:
        event.notes = (data["notes"] or "")[:255] or None
    if any(k in data for k in ("event_type", "session", "timestamp")):
        restamp_event(event)
        # Moving / retyping a time in can change which punch is the work
        # day's first arrival, in the old work day and the new one.
        db.session.flush()
        for work_date in {old_work_date, event.work_date}:
            refresh_arrival_lateness(event.user_id, work_date)
    log_action(caller.id, "ATTENDANCE_CORRECTED", "attendance_event", event.id,
               {"user_id": event.user_id, "before": before, "after": _snapshot(event)})
    db.session.commit()
    return jsonify(event_payload(event))


@attendance_bp.delete("/<event_id>")
@require_roles("ADMIN")
def delete_attendance(event_id):
    caller = load_current_user()
    event = db.session.get(AttendanceEvent, event_id)
    if not event:
        raise AppError("Attendance event not found.", 404)
    log_action(caller.id, "ATTENDANCE_DELETED", "attendance_event", event.id, event.to_dict())
    user_id, work_date = event.user_id, event.work_date
    db.session.delete(event)
    db.session.flush()
    # Deleting the first time in makes the next one the day's arrival.
    refresh_arrival_lateness(user_id, work_date)
    db.session.commit()
    return jsonify({"deleted": True, "id": event_id})
