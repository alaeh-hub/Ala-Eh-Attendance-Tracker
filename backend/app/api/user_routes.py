import re

from flask import Blueprint, Response, jsonify, request
from sqlalchemy import func, or_

from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.attendance_event import AttendanceEvent
from app.models.face_embedding import FaceEmbedding
from app.models.scan_snapshot import ScanSnapshot
from app.models.user import User
from app.services.auth_service import NO_LOGIN_HASH, register_user
from app.services.embedding_index import active_engine, embedding_index, model_filter
from app.utils.audit import log_action
from app.utils.auth import KIOSK_ROLE, load_current_user, require_roles
from app.utils.crypto import CryptoError, decrypt_bytes
from app.utils.security import hash_password
from app.utils.validators import is_valid_email, is_valid_password

user_bp = Blueprint("users", __name__)

ROLES = ("ADMIN", "STAFF", "OPERATOR", KIOSK_ROLE)
# Roles that exist to sign in, so they can't be created without a password.
LOGIN_ROLES = ("ADMIN", "OPERATOR", KIOSK_ROLE)
MAX_PAGE = 500
PROFILE_FIELDS = {"department": 80, "position": 80, "phone": 40}
PASSWORD_RULE = "Password must be 8 to 72 characters long."
EMPLOYEE_CODE_RE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")


def _clean(value, max_len):
    if value is None:
        return None
    if not isinstance(value, str):
        raise AppError("Invalid text value.", 400)
    value = value.strip()
    return value[:max_len] or None


def _next_employee_code() -> str:
    codes = [c for (c,) in db.session.query(User.employee_code).filter(User.employee_code.like("EMP-%")).all()]
    numbers = [int(c[4:]) for c in codes if c[4:].isdigit()]
    return f"EMP-{(max(numbers, default=0) + 1):04d}"


def _validate_employee_code(code: str, exclude_id: str | None = None) -> str:
    code = code.strip().upper()
    if not EMPLOYEE_CODE_RE.match(code):
        raise AppError("Employee ID may only contain letters, numbers, dot, dash and underscore.", 400)
    q = User.query.filter(func.upper(User.employee_code) == code)
    if exclude_id:
        q = q.filter(User.id != exclude_id)
    if q.first():
        raise AppError(f"Employee ID {code} is already in use.", 409)
    return code


def _sample_counts(user_ids=None) -> dict:
    q = (
        db.session.query(FaceEmbedding.user_id, func.count(FaceEmbedding.id))
        .filter(model_filter(active_engine().name))
        .group_by(FaceEmbedding.user_id)
    )
    if user_ids is not None:
        q = q.filter(FaceEmbedding.user_id.in_(user_ids))
    return dict(q.all())


def _serialize(user: User) -> dict:
    return user.to_dict(sample_count=_sample_counts([user.id]).get(user.id, 0))


def _remaining_admins(excluding_id: str) -> int:
    return User.query.filter(User.role == "ADMIN", User.is_active.is_(True), User.id != excluding_id).count()


@user_bp.post("")
@require_roles("ADMIN")
def create_user():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise AppError("A JSON object is required.", 400)

    full_name = _clean(data.get("full_name"), 120)
    email = _clean(data.get("email"), 120)
    password = data.get("password") or None
    role = data.get("role", "STAFF")

    if not full_name:
        raise AppError("A full name is required.", 400)
    if not email or not is_valid_email(email):
        raise AppError("A valid email address is required.", 400)
    if role not in ROLES:
        raise AppError("Invalid role.", 400)
    if role in LOGIN_ROLES and not password:
        raise AppError("Admins, operators and kiosk accounts need a password to sign in.", 400)
    if password is not None and not is_valid_password(password):
        raise AppError(PASSWORD_RULE, 400)

    raw_code = _clean(data.get("employee_code"), 40)
    employee_code = _validate_employee_code(raw_code) if raw_code else _next_employee_code()

    user = register_user(
        full_name,
        email.lower(),
        password,
        role,
        employee_code=employee_code,
        **{field: _clean(data.get(field), n) for field, n in PROFILE_FIELDS.items()},
    )
    log_action(load_current_user().id, "USER_CREATED", "user", user.id,
               {"email": user.email, "role": user.role, "employee_code": user.employee_code,
                "can_login": user.can_login})
    db.session.commit()
    return jsonify(user.to_dict(sample_count=0)), 201


@user_bp.get("")
@require_roles("ADMIN")
def list_users():
    q = User.query
    search = (request.args.get("q") or "").strip()
    if search:
        like = f"%{search}%"
        q = q.filter(or_(User.full_name.ilike(like), User.email.ilike(like),
                         User.employee_code.ilike(like), User.department.ilike(like)))
    if request.args.get("department"):
        q = q.filter(User.department == request.args["department"])
    status = request.args.get("status")
    if status == "active":
        q = q.filter(User.is_active.is_(True))
    elif status == "inactive":
        q = q.filter(User.is_active.is_(False))

    total = q.count()
    q = q.order_by(User.created_at.desc(), User.id)
    # Without `limit` every match is returned (older clients); the body stays
    # a plain array either way and the total travels in X-Total-Count.
    limit = _int_arg("limit", minimum=1)
    offset = _int_arg("offset", minimum=0) or 0
    if limit is not None:
        q = q.limit(min(limit, MAX_PAGE))
    if offset:
        q = q.offset(offset)
    users = q.all()
    counts = _sample_counts([u.id for u in users]) if limit is not None else _sample_counts()
    response = jsonify([u.to_dict(sample_count=counts.get(u.id, 0)) for u in users])
    response.headers["X-Total-Count"] = str(total)
    return response


def _int_arg(name: str, minimum: int) -> int | None:
    raw = request.args.get(name)
    if raw in (None, ""):
        return None
    try:
        value = int(raw)
    except ValueError:
        raise AppError(f"{name} must be an integer.", 400)
    if value < minimum:
        raise AppError(f"{name} must be at least {minimum}.", 400)
    return value


@user_bp.get("/departments")
@require_roles("ADMIN", "OPERATOR")
def list_departments():
    rows = db.session.query(User.department).filter(User.department.isnot(None)).distinct().all()
    return jsonify(sorted(d for (d,) in rows if d))


@user_bp.get("/next-code")
@require_roles("ADMIN")
def next_code():
    return jsonify({"employee_code": _next_employee_code()})


@user_bp.get("/<user_id>")
@require_roles("ADMIN")
def get_user(user_id):
    user = db.session.get(User, user_id)
    if not user:
        raise AppError("Employee not found.", 404)
    return jsonify(_serialize(user))


@user_bp.get("/<user_id>/photo")
@require_roles(allow_kiosk=True)  # the kiosk shows the matched employee's photo
def get_photo(user_id):
    caller = load_current_user()
    if caller.role == "STAFF" and caller.id != user_id:
        raise AppError("You don't have permission to view this photo.", 403)
    user = db.session.get(User, user_id)
    if not user or user.photo is None:
        raise AppError("No photo.", 404)
    try:
        photo = decrypt_bytes(user.photo)
    except CryptoError:
        raise AppError("Photo can't be decrypted — check FACE_DATA_KEY.", 500)
    return Response(photo, mimetype="image/jpeg", headers={"Cache-Control": "private, max-age=300"})


@user_bp.patch("/<user_id>")
@require_roles("ADMIN")
def update_user(user_id):
    """
    Update profile, password, sign-in access, active state and role in one
    request. Anything that changes what the account may do (password, sign-in
    revoked, deactivation, role) also bumps token_version, signing the user
    out everywhere on their next request.
    """
    caller = load_current_user()
    user = db.session.get(User, user_id)
    if not user:
        raise AppError("Employee not found.", 404)

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise AppError("A JSON object is required.", 400)
    is_self = user.id == caller.id
    before = {f: getattr(user, f) for f in ("full_name", "email", "employee_code", *PROFILE_FIELDS)}
    changes: dict = {}
    revoke = False

    if "full_name" in data:
        name = _clean(data["full_name"], 120)
        if not name:
            raise AppError("A full name is required.", 400)
        user.full_name = name

    if "email" in data:
        email = (_clean(data["email"], 120) or "").lower()
        if not is_valid_email(email):
            raise AppError("A valid email address is required.", 400)
        if User.query.filter(User.email == email, User.id != user.id).first():
            raise AppError("Another employee already uses this email.", 409)
        user.email = email

    if "employee_code" in data:
        code = _clean(data["employee_code"], 40)
        user.employee_code = _validate_employee_code(code, exclude_id=user.id) if code else None

    for field, n in PROFILE_FIELDS.items():
        if field in data:
            setattr(user, field, _clean(data[field], n))

    if "password" in data and data["password"]:
        if not is_valid_password(data["password"]):
            raise AppError(PASSWORD_RULE, 400)
        user.password_hash = hash_password(data["password"])
        changes["password_changed"] = True  # never the value
        revoke = True
    elif "revoke_login" in data and not isinstance(data["revoke_login"], bool):
        raise AppError("revoke_login must be a boolean.", 400)
    elif data.get("revoke_login") is True:
        if is_self:
            raise AppError("You can't revoke your own sign-in access.", 400)
        user.password_hash = NO_LOGIN_HASH
        changes["login_revoked"] = True
        revoke = True

    status_action = None
    if "is_active" in data:
        if not isinstance(data["is_active"], bool):
            raise AppError("is_active must be a boolean.", 400)
        deactivating = not data["is_active"]
        if deactivating and is_self:
            raise AppError("You can't deactivate your own account.", 400)
        if deactivating and user.role == "ADMIN" and _remaining_admins(user.id) == 0:
            raise AppError("Can't deactivate the last active admin.", 400)
        if user.is_active != data["is_active"]:
            status_action = "USER_REACTIVATED" if data["is_active"] else "USER_DEACTIVATED"
            revoke = revoke or deactivating
        user.is_active = data["is_active"]
        embedding_index.invalidate()  # deactivated employees can't be matched

    role_change = None
    if "role" in data:
        if data["role"] not in ROLES:
            raise AppError("Invalid role.", 400)
        if is_self and data["role"] != "ADMIN":
            raise AppError("You can't remove your own admin role.", 400)
        if user.role == "ADMIN" and data["role"] != "ADMIN" and _remaining_admins(user.id) == 0:
            raise AppError("Can't demote the last active admin.", 400)
        if data["role"] in LOGIN_ROLES and not user.can_login:
            raise AppError("Set a password before granting admin, operator or kiosk access.", 400)
        if data["role"] != user.role:
            role_change = {"from": user.role, "to": data["role"]}
            revoke = True
        user.role = data["role"]

    # Checked once everything is applied, so one request may both revoke
    # sign-in and demote to STAFF, but never leave an admin, operator or
    # kiosk account that nobody can sign in to.
    if changes.get("login_revoked") and user.role in LOGIN_ROLES:
        raise AppError("Admins, operators and kiosk accounts need sign-in access. Change the role first.", 400)

    if revoke:
        user.revoke_tokens()

    changed_fields = [f for f, old in before.items() if getattr(user, f) != old]
    if changed_fields or changes:
        log_action(caller.id, "USER_UPDATED", "user", user.id, {"fields": changed_fields, **changes})
    if role_change:
        log_action(caller.id, "USER_ROLE_CHANGED", "user", user.id, role_change)
    if status_action:
        log_action(caller.id, status_action, "user", user.id)
    db.session.commit()
    return jsonify(_serialize(user))


@user_bp.delete("/<user_id>")
@require_roles("ADMIN")
def delete_user(user_id):
    """
    Remove an employee. Attendance is a payroll/legal record, so someone
    with ANY attendance history is archived instead of deleted: the account
    is deactivated, sign-in and every token revoked, and the biometric data
    (face samples, photo, consent, their check-in snapshots) erased, while
    the attendance rows and the name on them stay. Without history the user
    is deleted outright.
    """
    caller = load_current_user()
    user = db.session.get(User, user_id)
    if not user:
        raise AppError("Employee not found.", 404)
    if user.id == caller.id:
        raise AppError("You can't delete your own account.", 400)
    if user.role == "ADMIN" and _remaining_admins(user.id) == 0:
        raise AppError("Can't delete the last active admin.", 400)

    has_history = db.session.query(AttendanceEvent.id).filter(AttendanceEvent.user_id == user.id).first() is not None
    samples = FaceEmbedding.query.filter_by(user_id=user.id).delete(synchronize_session=False)
    snapshots = ScanSnapshot.query.filter_by(user_id=user.id).delete(synchronize_session=False)
    details = {"email": user.email, "employee_code": user.employee_code, "role": user.role,
               "face_samples": samples, "snapshots": snapshots}

    if has_history:
        user.is_active = False
        user.password_hash = NO_LOGIN_HASH
        user.photo = None
        user.biometric_consent_at = None
        user.biometric_consent_by = None
        user.revoke_tokens()
        log_action(caller.id, "USER_ARCHIVED", "user", user.id, details)
        result = {"deleted": False, "archived": True, "id": user_id}
    else:
        db.session.expire(user, ["embeddings", "snapshots"])  # rows already removed above
        db.session.delete(user)
        log_action(caller.id, "USER_DELETED", "user", user_id, details)
        result = {"deleted": True, "archived": False, "id": user_id}
    db.session.commit()
    embedding_index.invalidate()
    return jsonify(result)
