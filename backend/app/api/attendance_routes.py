from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from app.extensions import db, socketio
from app.middleware.error_handler import AppError
from app.models.attendance_event import AttendanceEvent
from app.models.user import User
from app.services.attendance_service import event_payload, record_attendance
from app.utils.audit import log_action
from app.utils.auth import load_current_user, require_roles
from app.utils.timezone import org_day_bounds_utc, org_tz

attendance_bp = Blueprint("attendance", __name__)


def parse_day(value: str | None):
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise AppError("Dates must be YYYY-MM-DD.", 400)


def filtered_events_query(caller):
    """Shared filters for the list endpoint and CSV export."""
    query = AttendanceEvent.query.join(User, User.id == AttendanceEvent.user_id)
    if caller.role == "STAFF":
        query = query.filter(AttendanceEvent.user_id == caller.id)
    elif request.args.get("user_id"):
        query = query.filter(AttendanceEvent.user_id == request.args["user_id"])

    start_day, end_day = parse_day(request.args.get("from")), parse_day(request.args.get("to"))
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
    """STAFF sees only their own events; ADMIN/OPERATOR can filter by user, department and date range."""
    caller = load_current_user()
    try:
        limit = max(1, min(int(request.args.get("limit", 50)), 1000))
    except ValueError:
        raise AppError("limit must be a number.", 400)
    events = filtered_events_query(caller).order_by(AttendanceEvent.timestamp.desc()).limit(limit).all()
    return jsonify([event_payload(e) for e in events])


@attendance_bp.post("")
@require_roles("ADMIN")
def manual_entry():
    """Admin records an event by hand (e.g. camera down). Always audited."""
    caller = load_current_user()
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        raise AppError("A JSON object is required.", 400)
    user_id = data.get("user_id")
    event_type = data.get("event_type")
    session = data.get("session") or None
    reason = data.get("notes") if isinstance(data.get("notes"), str) else ""
    reason = reason.strip()
    if not isinstance(user_id, str) or not user_id or event_type not in ("CLOCK_IN", "CLOCK_OUT"):
        raise AppError("user_id and event_type (CLOCK_IN/CLOCK_OUT) are required.", 400)
    if session is not None and session not in ("AM", "PM", "OT"):
        raise AppError("session must be AM, PM or OT.", 400)
    if not reason:
        raise AppError("A reason is required for manual entries.", 400)
    if len(reason) > 255:
        raise AppError("The reason must be at most 255 characters.", 400)

    timestamp = None
    if data.get("timestamp"):
        try:
            parsed = datetime.fromisoformat(str(data["timestamp"]).replace("Z", "+00:00"))
        except ValueError:
            raise AppError("Invalid timestamp.", 400)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=org_tz())
        timestamp = parsed.astimezone(timezone.utc).replace(tzinfo=None)

    event = record_attendance(
        user_id=user_id, match_score=0.0, match_status="MANUAL", liveness_passed=False,
        device_id="manual", event_type=event_type, session=session, timestamp=timestamp,
        notes=f"Manual: {reason}"[:255], enforce_cooldown=False,
    )
    log_action(caller.id, "ATTENDANCE_MANUAL_ENTRY", "attendance_event", event.id,
               {"user_id": user_id, "event_type": event_type, "reason": reason})
    db.session.commit()
    payload = event_payload(event)
    socketio.emit("attendance_event", payload, to="dashboards")
    return jsonify(payload), 201


@attendance_bp.patch("/<event_id>")
@require_roles("ADMIN")
def correct_attendance(event_id):
    caller = load_current_user()
    event = db.session.get(AttendanceEvent, event_id)
    if not event:
        raise AppError("Attendance event not found.", 404)

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        raise AppError("A JSON object is required.", 400)
    if not data:
        raise AppError("At least one field to update is required.", 400)
    if "event_type" in data and data["event_type"] not in ("CLOCK_IN", "CLOCK_OUT"):
        raise AppError("event_type must be CLOCK_IN or CLOCK_OUT.", 400)
    before = {"event_type": event.event_type, "notes": event.notes}
    if data.get("event_type") in ("CLOCK_IN", "CLOCK_OUT"):
        event.event_type = data["event_type"]
    if "notes" in data:
        if data["notes"] is not None and not isinstance(data["notes"], str):
            raise AppError("notes must be text.", 400)
        event.notes = (data["notes"] or "")[:255] or None
    log_action(caller.id, "ATTENDANCE_CORRECTED", "attendance_event", event.id,
               {"before": before, "after": {"event_type": event.event_type, "notes": event.notes}})
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
    db.session.delete(event)
    db.session.commit()
    return jsonify({"deleted": True, "id": event_id})
