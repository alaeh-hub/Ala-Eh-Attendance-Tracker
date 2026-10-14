from flask import Blueprint, jsonify, request

from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.attendance_event import AttendanceEvent
from app.models.department import Department
from app.models.face_embedding import FaceEmbedding
from app.models.scan_snapshot import ScanSnapshot
from app.models.user import User
from app.services.auth_service import verify_user_password
from app.services.embedding_index import embedding_index
from app.utils.audit import log_action
from app.utils.auth import KIOSK_ROLE, load_current_user, require_roles

admin_bp = Blueprint("admin", __name__)


@admin_bp.post("/clear-all-data")
@require_roles("ADMIN")
def clear_all_data():
    """
    Factory-reset the company data. Deletes every face sample and profile
    photo, the whole review queue (scan snapshots), every attendance record
    and all employees. Kept: administrator accounts, departments, the audit
    log and (unless asked to remove them) operator and kiosk device accounts.

    The audit log is deliberately never wiped: it is the record that a reset
    happened and of everything before it, and an administrator able to erase
    it could hide what they did. An ALL_DATA_CLEARED entry is added.

    It cannot be undone, so it needs the typed word DELETE and the signed-in
    administrator's password.
    """
    caller = load_current_user()
    data = request.get_json(silent=True)
    data = data if isinstance(data, dict) else {}
    if data.get("confirm") != "DELETE":
        raise AppError("Type DELETE to confirm.", 400)
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    verify_user_password(caller, password)

    keep_operators = data.get("keep_operators", True) is not False
    keep_roles = ["ADMIN", "OPERATOR", KIOSK_ROLE] if keep_operators else ["ADMIN"]

    try:
        # Children before parents: snapshots and events reference users.
        snapshots = ScanSnapshot.query.delete(synchronize_session=False)
        events = AttendanceEvent.query.delete(synchronize_session=False)
        samples = FaceEmbedding.query.delete(synchronize_session=False)
        users_removed = User.query.filter(User.role.notin_(keep_roles)).delete(synchronize_session=False)
        # Accounts that stay lose what came from face data: the profile photo and the recorded consent.
        User.query.update({User.photo: None, User.biometric_consent_at: None, User.biometric_consent_by: None},
                          synchronize_session=False)
        kept = {
            "admins": User.query.filter_by(role="ADMIN").count(),
            "operators": User.query.filter_by(role="OPERATOR").count(),
            "kiosks": User.query.filter_by(role=KIOSK_ROLE).count(),
            "departments": Department.query.count(),
        }
        result = {
            "users_removed": users_removed,
            "face_samples": samples,
            "review_snapshots": snapshots,
            "attendance_events": events,
            "kept": kept,
        }
        log_action(caller.id, "ALL_DATA_CLEARED", None, None, {**result, "keep_operators": keep_operators})
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise

    embedding_index.invalidate()
    return jsonify(result)
