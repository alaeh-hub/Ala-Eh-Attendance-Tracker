from datetime import datetime

from flask import Blueprint, Response, jsonify, request

from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.scan_snapshot import ScanSnapshot
from app.models.user import User
from app.services.face_service import enroll_sample
from app.services.snapshot_service import PENDING_STATUSES, purge_old
from app.utils.audit import log_action
from app.utils.auth import load_current_user, require_roles
from app.utils.crypto import CryptoError, decrypt_bytes

review_bp = Blueprint("review", __name__)

FILTERS = ("pending", "matched", "resolved", "all")


def _get(snapshot_id: str) -> ScanSnapshot:
    snap = db.session.get(ScanSnapshot, snapshot_id)
    if not snap:
        raise AppError("Snapshot not found.", 404)
    return snap


def _pending_count() -> int:
    return ScanSnapshot.query.filter(ScanSnapshot.status.in_(PENDING_STATUSES), ScanSnapshot.resolution.is_(None)).count()


def _image(snap: ScanSnapshot) -> bytes:
    try:
        return decrypt_bytes(snap.image)
    except CryptoError:
        raise AppError("Snapshot can't be decrypted. Check FACE_DATA_KEY.", 500)


@review_bp.get("/snapshots")
@require_roles("ADMIN")
def list_snapshots():
    purge_old()
    flt = request.args.get("filter", "pending")
    if flt not in FILTERS:
        raise AppError("filter must be one of: " + ", ".join(FILTERS), 400)
    limit = max(1, min(request.args.get("limit", 48, type=int), 100))
    offset = max(0, request.args.get("offset", 0, type=int))

    q = ScanSnapshot.query
    if flt == "pending":
        q = q.filter(ScanSnapshot.status.in_(PENDING_STATUSES), ScanSnapshot.resolution.is_(None))
    elif flt == "matched":
        q = q.filter(ScanSnapshot.status == "MATCHED")
    elif flt == "resolved":
        q = q.filter(ScanSnapshot.resolution.isnot(None))
    if request.args.get("event_id"):
        q = q.filter(ScanSnapshot.event_id == request.args["event_id"])

    total = q.count()
    rows = q.order_by(ScanSnapshot.created_at.desc()).offset(offset).limit(limit).all()
    ids = {i for r in rows for i in (r.user_id, r.candidate_user_id) if i}
    names = {u.id: u.full_name for u in User.query.filter(User.id.in_(ids)).all()} if ids else {}
    return jsonify({"items": [r.to_dict(names) for r in rows], "total": total, "pending_count": _pending_count()})


@review_bp.get("/snapshots/<snapshot_id>/image")
@require_roles("ADMIN")
def snapshot_image(snapshot_id):
    snap = _get(snapshot_id)
    image = _image(snap)
    log_action(load_current_user().id, "SNAPSHOT_VIEWED", "scan_snapshot", snap.id)
    db.session.commit()
    return Response(image, mimetype="image/jpeg", headers={"Cache-Control": "private, no-store"})


@review_bp.post("/snapshots/<snapshot_id>/enroll")
@require_roles("ADMIN")
def enroll_from_snapshot(snapshot_id):
    """Add a reviewed frame as an extra enrollment sample for the chosen employee."""
    snap = _get(snapshot_id)
    data = request.get_json(silent=True) or {}
    user_id = data.get("user_id")
    if not user_id:
        raise AppError("user_id is required.", 400)
    actor = load_current_user()

    result = enroll_sample(user_id, _image(snap), pose_label="review", consent=bool(data.get("consent")), actor_id=actor.id)
    snap.resolution = "ADDED"
    snap.reviewed_by, snap.reviewed_at = actor.id, datetime.utcnow()
    log_action(actor.id, "SNAPSHOT_ENROLLED", "scan_snapshot", snap.id, {"user_id": user_id})
    db.session.commit()
    return jsonify({**result, "pending_count": _pending_count()})


@review_bp.post("/snapshots/<snapshot_id>/dismiss")
@require_roles("ADMIN")
def dismiss_snapshot(snapshot_id):
    snap = _get(snapshot_id)
    actor = load_current_user()
    snap.resolution = "DISMISSED"
    snap.reviewed_by, snap.reviewed_at = actor.id, datetime.utcnow()
    log_action(actor.id, "SNAPSHOT_DISMISSED", "scan_snapshot", snap.id)
    db.session.commit()
    return jsonify({"ok": True, "pending_count": _pending_count()})


@review_bp.delete("/snapshots/<snapshot_id>")
@require_roles("ADMIN")
def delete_snapshot(snapshot_id):
    snap = _get(snapshot_id)
    log_action(load_current_user().id, "SNAPSHOT_DELETED", "scan_snapshot", snap.id)
    db.session.delete(snap)
    db.session.commit()
    return jsonify({"ok": True, "pending_count": _pending_count()})
