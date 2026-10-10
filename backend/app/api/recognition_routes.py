import logging

from flask import Blueprint, current_app, jsonify, request

from app.extensions import db, socketio
from app.middleware.error_handler import AppError
from app.models.user import User
from app.services.attendance_service import (
    EVENT_TYPES,
    SESSIONS,
    AlreadyVerified,
    CooldownActive,
    event_payload,
    record_attendance,
)
from app.services.face_service import face_present, recognize_burst
from app.vision.zone import parse_zone
from app.services.snapshot_service import save_snapshot
from app.utils.blocking import run_blocking
from app.utils.auth import require_roles
from app.utils.timezone import now_in_org_tz
from app.vision.liveness import liveness_tracker

recognition_bp = Blueprint("recognition", __name__)
logger = logging.getLogger("app.recognition")

MAX_FRAMES = 16


def _log_outcome(status: str, device_id: str, result: dict, user=None, extra: str = ""):
    """
    One structured line per check-in attempt with the actual match score,
    so "why did the kiosk reject this person" is answerable from the logs
    alone instead of only from the JSON response the kiosk already dropped.
    """
    logger.info(
        "check-in device=%s status=%s score=%s runner_up=%s vote_ratio=%s frames=%s/%s engine=%s elapsed_ms=%s user=%s%s",
        device_id,
        status,
        round(result["score"], 4) if result.get("score") is not None else None,
        round(result["runner_up_score"], 4) if result.get("runner_up_score") is not None else None,
        result.get("vote_ratio"),
        result.get("frames_embedded"),
        result.get("frames_with_face"),
        result.get("engine"),
        result.get("elapsed_ms"),
        f"{user.employee_code or user.id} ({user.full_name})" if user else result.get("user_id"),
        extra,
    )


@recognition_bp.get("/kiosk-config")
@require_roles()
def kiosk_config():
    """What the kiosk needs to decide which punches it should offer right now:
    the organisation's current time (the tablet's own clock and timezone may differ)
    and the default lunch break that splits the morning from the afternoon."""
    now = now_in_org_tz()
    cfg = current_app.config
    return jsonify({
        "local_minutes": now.hour * 60 + now.minute + now.second / 60.0,
        "break_start": cfg["BREAK_START"],
        "break_end": cfg["BREAK_END"],
    })


@recognition_bp.post("/presence")
@require_roles()
def presence():
    """The idle kiosk polls this with a small frame to find out whether someone has walked
    up to it. Detection only: the frame is not stored, and nobody is identified."""
    frame = request.files.get("frame")
    if frame is None:
        raise AppError("A 'frame' image is required.", 400)
    zone = parse_zone(request.form.get("zone"))
    return jsonify({"present": bool(run_blocking(face_present, frame.read(), zone))})


@recognition_bp.post("/check-in")
@require_roles("ADMIN", "OPERATOR")
def check_in():
    """
    Kiosk endpoint. Expects a burst of frames (multipart field "frames",
    ~8-10 JPEGs ~120ms apart) so recognition and blink liveness are
    assessed together. Always returns a structured status the frontend
    must handle: NO_FACE, NO_MATCH, LOW_CONFIDENCE, AMBIGUOUS_MATCH,
    LIVENESS_FAILED, COOLDOWN, VERIFIED, MATCHED.
    """
    files = request.files.getlist("frames")
    if not files:
        raise AppError("At least one frame is required (field 'frames').", 400)
    if len(files) > MAX_FRAMES:
        raise AppError(f"No more than {MAX_FRAMES} frames may be sent per check-in.", 413)
    device_id = (request.form.get("device_id") or "kiosk")[:80]
    # The kiosk's six buttons (AM/PM/OT x In/Out) arrive as a
    # (session, event_type) pair, or neither for "Auto". Both are only
    # hints: attendance_service.resolve_punch decides the punch that is
    # actually written, overruling a selection the day's record
    # contradicts. See the `corrected` flag on a MATCHED response.
    requested_event_type = request.form.get("event_type") or None
    if requested_event_type and requested_event_type not in EVENT_TYPES:
        raise AppError("event_type must be CLOCK_IN or CLOCK_OUT.", 400)
    requested_session = request.form.get("session") or None
    if requested_session and requested_session not in SESSIONS:
        raise AppError("session must be AM, PM or OT.", 400)
    if bool(requested_session) != bool(requested_event_type):
        raise AppError("session and event_type must be sent together.", 400)
    cfg = current_app.config

    # Where the kiosk's guide oval sits in the frame. Absent or implausible = no restriction.
    zone = parse_zone(request.form.get("zone"))
    result = run_blocking(recognize_burst, [f.read() for f in files], zone)
    meta = {
        "elapsed_ms": result.get("elapsed_ms"),
        "frames_with_face": result.get("frames_with_face", 0),
    }

    if result["status"] == "NO_FACE":
        logger.info("check-in device=%s status=NO_FACE reason=%r elapsed_ms=%s", device_id, result["reason"], result.get("elapsed_ms"))
        return jsonify({"status": "NO_FACE", "reason": result["reason"], **meta}), 200

    snapshot = result.get("snapshot_jpeg")
    snap_args = dict(device_id=device_id, score=result.get("score"), runner_up_score=result.get("runner_up_score"),
                     spoof_score=result.get("spoof_score"))

    if result["status"] != "MATCHED":
        _log_outcome(result["status"], device_id, result)
        save_snapshot(snapshot, result["status"], candidate_user_id=result.get("candidate_user_id"), **snap_args)
        return jsonify({"status": result["status"], "score": round(result["score"], 4),
                        "reason": result.get("reason"), **meta}), 200

    user = db.session.get(User, result["user_id"])
    if not user or not user.is_active:
        _log_outcome("NO_MATCH", device_id, result, extra=" reason=inactive_or_deleted_user")
        return jsonify({"status": "NO_MATCH", "reason": "The matched employee is no longer active.", **meta}), 200
    identity = {
        "user_id": user.id,
        "user_name": user.full_name,
        "employee_code": user.employee_code,
        "department": user.department,
        "has_photo": user.photo is not None,
    }

    if result.get("spoof_suspected"):
        _log_outcome("SPOOF_SUSPECTED", device_id, result, user=user, extra=f" spoof_score={result.get('spoof_score')}")
        save_snapshot(snapshot, "SPOOF_SUSPECTED", user_id=user.id, candidate_user_id=user.id, **snap_args)
        return jsonify({
            "status": "SPOOF_SUSPECTED",
            "reason": "Please show your live face to the camera. Photos and screens are not accepted.",
            **meta,
        }), 200

    if cfg["LIVENESS_REQUIRED"]:
        liveness = liveness_tracker.add_and_evaluate(
            (device_id, user.id), result["ears"], cfg["LIVENESS_WINDOW_SECONDS"], cfg["LIVENESS_EAR_BLINK_DELTA"]
        )
        if not liveness["passed"]:
            # Recognised but not yet proven live: tell the kiosk who we think
            # it is (first name only) so the prompt feels personal, but record
            # nothing. The EAR samples are pooled for the next scan.
            _log_outcome("LIVENESS_FAILED", device_id, result, user=user, extra=f" reason={liveness['reason']!r}")
            save_snapshot(snapshot, "LIVENESS_FAILED", user_id=user.id, **snap_args)
            return jsonify({
                "status": "LIVENESS_FAILED",
                "reason": liveness["reason"],
                "first_name": user.full_name.split(" ")[0],
                "score": round(result["score"], 4),
                **meta,
            }), 200

    try:
        event = record_attendance(
            user_id=user.id,
            match_score=result["score"],
            match_status="MATCHED",
            liveness_passed=cfg["LIVENESS_REQUIRED"],
            device_id=device_id,
            event_type=requested_event_type,
            session=requested_session,
        )
    except CooldownActive as cd:
        _log_outcome("COOLDOWN", device_id, result, user=user, extra=f" seconds_remaining={cd.seconds_remaining}")
        return jsonify({
            "status": "COOLDOWN",
            "reason": f"Already recorded. You can scan again in {cd.seconds_remaining}s.",
            "event": event_payload(cd.last_event),
            **identity,
            **meta,
        }), 200
    except AlreadyVerified as av:
        _log_outcome("VERIFIED", device_id, result, user=user)
        return jsonify({
            "status": "VERIFIED",
            "reason": av.reason,
            "event": event_payload(av.last_event),
            # Seconds left in the re-verification window, when that is what
            # this scan was. None once the window has closed and the punch
            # is simply already on record for today.
            "seconds_remaining": av.seconds_remaining,
            **identity,
            **meta,
        }), 200

    _log_outcome("MATCHED", device_id, result, user=user, extra=f" event_type={event.event_type} session={event.session}")
    save_snapshot(snapshot, "MATCHED", user_id=user.id, event_id=event.id, **snap_args)
    payload = event_payload(event)
    socketio.emit("attendance_event", payload, to="dashboards")
    return jsonify({
        "status": "MATCHED",
        "event": payload,
        "score": round(result["score"], 4),
        # True when the punch written differs from the button pressed;
        # correction_note explains it in words the employee can read.
        "corrected": payload["corrected"],
        "correction_note": payload["correction_note"],
        "reverify_seconds": current_app.config["ATTENDANCE_REVERIFY_WINDOW_SECONDS"],
        **meta,
    }), 201
