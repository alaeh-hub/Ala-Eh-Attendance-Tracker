import re

from flask import Blueprint, Response, jsonify, request
from sqlalchemy import func, or_

from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.attendance_event import AttendanceEvent
from app.models.face_embedding import FaceEmbedding
from app.models.department import Department
from app.models.scan_snapshot import ScanSnapshot
from app.models.user import User
from app.services.auth_service import NO_LOGIN_HASH, register_user
from app.services.embedding_index import active_engine, embedding_index, model_filter
from app.utils.audit import log_action
from app.utils.auth import KIOSK_ROLE, load_current_user, require_roles
from app.utils.crypto import CryptoError, decrypt_bytes
from app.utils.search import smart_filter
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


def _department_name(value):
    """Resolve a selected department to its canonical name; reject typos."""
    value = _clean(value, PROFILE_FIELDS["department"])
    if value is None:
        return None
    dept = Department.query.filter(func.lower(Department.name) == value.lower()).first()
    if dept is None:
        raise AppError("Choose a department that exists, or leave this field empty.", 400)
    return dept.name


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
        **{field: (_department_name(data.get(field)) if field == "department" else _clean(data.get(field), n))
           for field, n in PROFILE_FIELDS.items()},
    )
    log_action(load_current_user().id, "USER_CREATED", "user", user.id,
               {"email": user.email, "role": user.role, "employee_code": user.employee_code,
                "can_login": user.can_login})
    db.session.commit()
    return jsonify(user.to_dict(sample_count=0)), 201


# A search scores at most this many employees (newest first); well past any realistic headcount.
SEARCH_SCAN_LIMIT = 20000


@user_bp.get("")
@require_roles("ADMIN")
def list_users():
    q = User.query
    if request.args.get("department"):
        q = q.filter(User.department == request.args["department"])
    status = request.args.get("status")
    if status == "active":
        q = q.filter(User.is_active.is_(True))
    elif status == "inactive":
        q = q.filter(User.is_active.is_(False))

    limit = _int_arg("limit", minimum=1)
    offset = _int_arg("offset", minimum=0) or 0
    search = (request.args.get("q") or "").strip()
    if search:
        # Smart search (see app/utils/search.py): every word must match, accents and typos are forgiven, best match first.
        cols = (User.id, User.full_name, User.employee_code, User.email, User.department, User.position)
        rows = q.with_entities(*cols).order_by(User.created_at.desc(), User.id).limit(SEARCH_SCAN_LIMIT).all()
        ranked_ids = [r.id for r in smart_filter(rows, search, lambda r: (r.full_name, r.employee_code, r.email, r.department, r.position))]
        total = len(ranked_ids)
        page_ids = ranked_ids[offset:]
        if limit is not None:
            page_ids = page_ids[:min(limit, MAX_PAGE)]
        by_id = {u.id: u for u in User.query.filter(User.id.in_(page_ids)).all()} if page_ids else {}
        users = [by_id[i] for i in page_ids if i in by_id]
    else:
        total = q.count()
        q = q.order_by(User.created_at.desc(), User.id)
        # Without `limit` every match is returned (older clients); the body stays
        # a plain array either way and the total travels in X-Total-Count.
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
@require_roles("ADMIN", "OPERATOR", allow_kiosk=True)  # kiosk shows a matched employee's photo
def get_photo(user_id):
    user = db.session.get(User, user_id)
    if not user or user.photo is None:
        raise AppError("No photo.", 404)
    try:
        photo = decrypt_bytes(user.photo)
    except CryptoError:
        raise AppError("Photo can't be decrypted — check FACE_DATA_KEY.", 500)
    return Response(photo, mimetype="image/jpeg", headers={"Cache-Control": "private, max-age=300"})


def _require_bool(data: dict, key: str) -> None:
    if not isinstance(data[key], bool):
        raise AppError(f"{key} must be a boolean.", 400)


def _apply_profile(user: User, data: dict) -> None:
    """Name, email, employee code and the free-text profile fields."""
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
            setattr(user, field, _department_name(data[field]) if field == "department" else _clean(data[field], n))


def _apply_credentials(user: User, data: dict, is_self: bool) -> tuple[dict, bool]:
    """Set a new password or revoke sign-in. Returns (audit details, whether
    the user's tokens must be revoked). The password value is never audited."""
    if data.get("password"):
        if not is_valid_password(data["password"]):
            raise AppError(PASSWORD_RULE, 400)
        user.password_hash = hash_password(data["password"])
        return {"password_changed": True}, True
    if "revoke_login" in data:
        _require_bool(data, "revoke_login")
    if data.get("revoke_login") is True:
        if is_self:
            raise AppError("You can't revoke your own sign-in access.", 400)
        user.password_hash = NO_LOGIN_HASH
        return {"login_revoked": True}, True
    return {}, False


def _apply_active_state(user: User, data: dict, is_self: bool) -> tuple[str | None, bool]:
    """Activate or deactivate. Returns (audit action if the state changed,
    whether the user's tokens must be revoked)."""
    if "is_active" not in data:
        return None, False
    _require_bool(data, "is_active")
    active = data["is_active"]
    deactivating = not active
    if deactivating and is_self:
        raise AppError("You can't deactivate your own account.", 400)
    if deactivating and user.role == "ADMIN" and _remaining_admins(user.id) == 0:
        raise AppError("Can't deactivate the last active admin.", 400)
    action = None
    if user.is_active != active:
        action = "USER_REACTIVATED" if active else "USER_DEACTIVATED"
    user.is_active = active
    embedding_index.invalidate()  # deactivated employees can't be matched
    return action, deactivating and action is not None


def _apply_role(user: User, data: dict, is_self: bool) -> dict | None:
    """Change the role. Returns {"from", "to"} when it actually changed."""
    if "role" not in data:
        return None
    role = data["role"]
    if role not in ROLES:
        raise AppError("Invalid role.", 400)
    if is_self and role != "ADMIN":
        raise AppError("You can't remove your own admin role.", 400)
    if user.role == "ADMIN" and role != "ADMIN" and _remaining_admins(user.id) == 0:
        raise AppError("Can't demote the last active admin.", 400)
    if role in LOGIN_ROLES and not user.can_login:
        raise AppError("Set a password before granting admin, operator or kiosk access.", 400)
    change = {"from": user.role, "to": role} if role != user.role else None
    user.role = role
    return change


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

    _apply_profile(user, data)
    changes, revoke = _apply_credentials(user, data, is_self)
    status_action, revoke_for_status = _apply_active_state(user, data, is_self)
    role_change = _apply_role(user, data, is_self)
    revoke = revoke or revoke_for_status or role_change is not None

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
