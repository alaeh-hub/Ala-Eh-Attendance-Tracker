from flask import Blueprint, request, jsonify
from app.services.face_service import assess_capture_readiness, debug_allowed, enroll_sample, get_enrollment_status, reset_all_enrollments, reset_enrollment
from app.middleware.error_handler import AppError
from app.extensions import db
from app.utils.audit import log_action
from app.models.user import User
from app.utils.auth import KIOSK_ROLE, require_roles, load_current_user
from app.utils.ratelimit import rate_limit, user_key
from app.vision.zone import parse_zone

enrollment_bp = Blueprint("enrollment", __name__)

# Guided pose sequence the frontend walks the employee through. Several
# angles make recognition robust when people don't face the camera squarely.
POSE_SEQUENCE = ["frontal", "left", "right", "up", "down", "frontal_2"]


@enrollment_bp.get("/poses")
@require_roles()
def get_pose_sequence():
    return jsonify({"poses": POSE_SEQUENCE})


@enrollment_bp.get("/status")
@require_roles()
def status():
    caller = load_current_user()
    target_user_id = request.args.get("target_user_id")
    if target_user_id and target_user_id != caller.id and caller.role != "ADMIN":
        raise AppError("Only an admin can view another employee's enrollment status.", 403)
    return jsonify(get_enrollment_status(target_user_id or caller.id))


@enrollment_bp.delete("/samples")
@require_roles("ADMIN")
def delete_samples():
    caller = load_current_user()
    target = request.args.get("target_user_id") or caller.id
    result = reset_enrollment(target)
    log_action(caller.id, "FACE_DATA_RESET", "user", target, {"deleted_count": result["deleted_count"]})
    db.session.commit()
    return jsonify(result)


@enrollment_bp.delete("/samples/all")
@require_roles("ADMIN")
def delete_all_samples():
    caller = load_current_user()
    result = reset_all_enrollments()
    log_action(caller.id, "FACE_DATA_CLEARED_ALL", None, None, result)
    db.session.commit()
    return jsonify(result)


def _pose_from_form() -> str:
    """Only the guided poses are accepted: the label drives the pose check and
    the per-pose progress shown to the admin."""
    pose = (request.form.get("pose") or "frontal")[:30]
    if pose not in POSE_SEQUENCE:
        raise AppError(f"Unknown pose. Use one of: {', '.join(POSE_SEQUENCE)}.", 400)
    return pose


def _opt_float(name: str) -> float | None:
    value = request.form.get(name)
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


@enrollment_bp.post("/check")
@require_roles("ADMIN")
@rate_limit("enroll-check", limit=120, per=60, key=user_key)
def check_readiness():
    """
    Admin-only preview check: scores the current frame's quality/pose
    without saving a sample, so the UI can show live "ready" feedback
    while the employee is positioning for a pose.
    """
    if "image" not in request.files:
        raise AppError("Missing 'image' file in form data.", 400)
    pose = _pose_from_form()

    baseline_yaw, baseline_pitch = _opt_float("baseline_yaw"), _opt_float("baseline_pitch")
    baseline = (baseline_yaw, baseline_pitch) if baseline_yaw is not None and baseline_pitch is not None else None
    base = pose.split("_")[0]
    reference = _opt_float("reference_yaw") if base == "right" else _opt_float("reference_pitch") if base == "down" else None

    # Development only: with debug=1 the answer also says what the detector saw (boxes, landmarks, numbers).
    # A production server ignores the flag.
    debug = {} if request.form.get("debug") == "1" and debug_allowed() else None
    result = assess_capture_readiness(request.files["image"].read(), pose, baseline=baseline, reference=reference,
                                      zone=parse_zone(request.form.get("zone")), debug=debug)
    if debug is not None:
        result["debug"] = debug
    return jsonify(result)


@enrollment_bp.post("/sample")
@require_roles("ADMIN")
@rate_limit("enroll-sample", limit=120, per=60, key=user_key)
def submit_sample():
    """
    Admin-only: accepts one captured frame (multipart field "image") plus a
    "pose" label for target_user_id. Enrollment is supervised so nobody can
    enroll a colleague's face under their own name (buddy punching).
    """
    if "image" not in request.files:
        raise AppError("Missing 'image' file in form data.", 400)

    caller = load_current_user()
    user_id = request.form.get("target_user_id") or caller.id
    target = db.session.get(User, user_id)
    if target is not None and target.role == KIOSK_ROLE:
        raise AppError("Kiosk device accounts don't have a face to enroll.", 400)
    pose = _pose_from_form()
    consent = (request.form.get("consent") or "").lower() in ("1", "true", "yes", "on")
    result = enroll_sample(user_id, request.files["image"].read(), pose_label=pose, consent=consent, actor_id=caller.id,
                           zone=parse_zone(request.form.get("zone")))
    log_action(caller.id, "FACE_SAMPLE_ENROLLED", "user", user_id, {"pose": pose, "sample_count": result["sample_count"]})
    db.session.commit()
    return jsonify(result), 201
