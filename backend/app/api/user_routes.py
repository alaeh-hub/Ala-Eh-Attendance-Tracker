import re

from flask import Blueprint, Response, jsonify, request
from sqlalchemy import func, or_

from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.face_embedding import FaceEmbedding
from app.models.user import User
from app.services.auth_service import NO_LOGIN_HASH, register_user
from app.services.embedding_index import active_engine, embedding_index, model_filter
from app.utils.auth import load_current_user, require_roles
from app.utils.crypto import CryptoError, decrypt_bytes
from app.utils.security import hash_password
from app.utils.validators import is_valid_email, is_valid_password

user_bp = Blueprint("users", __name__)

ROLES = ("ADMIN", "STAFF", "OPERATOR")
PROFILE_FIELDS = {"department": 80, "position": 80, "phone": 40}
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
    if role in ("ADMIN", "OPERATOR") and not password:
        raise AppError("Admins and operators need a password to sign in.", 400)
    if password is not None and not is_valid_password(password):
        raise AppError("Password must be at least 8 characters.", 400)

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

    users = q.order_by(User.created_at.desc()).all()
    counts = _sample_counts()
    return jsonify([u.to_dict(sample_count=counts.get(u.id, 0)) for u in users])


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
@require_roles()
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
    caller = load_current_user()
    user = db.session.get(User, user_id)
    if not user:
        raise AppError("Employee not found.", 404)

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise AppError("A JSON object is required.", 400)
    is_self = user.id == caller.id

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
            raise AppError("Password must be at least 8 characters.", 400)
        user.password_hash = hash_password(data["password"])
    elif "revoke_login" in data and not isinstance(data["revoke_login"], bool):
        raise AppError("revoke_login must be a boolean.", 400)
    elif data.get("revoke_login") is True:
        if is_self:
            raise AppError("You can't revoke your own sign-in access.", 400)
        user.password_hash = NO_LOGIN_HASH

    if "is_active" in data:
        if not isinstance(data["is_active"], bool):
            raise AppError("is_active must be a boolean.", 400)
        deactivating = not bool(data["is_active"])
        if deactivating and is_self:
            raise AppError("You can't deactivate your own account.", 400)
        if deactivating and user.role == "ADMIN" and _remaining_admins(user.id) == 0:
            raise AppError("Can't deactivate the last active admin.", 400)
        user.is_active = bool(data["is_active"])
        embedding_index.invalidate()  # deactivated employees can't be matched

    if "role" in data:
        if data["role"] not in ROLES:
            raise AppError("Invalid role.", 400)
        if is_self and data["role"] != "ADMIN":
            raise AppError("You can't remove your own admin role.", 400)
        if user.role == "ADMIN" and data["role"] != "ADMIN" and _remaining_admins(user.id) == 0:
            raise AppError("Can't demote the last active admin.", 400)
        if data["role"] in ("ADMIN", "OPERATOR") and not user.can_login:
            raise AppError("Set a password before granting admin or operator access.", 400)
        user.role = data["role"]

    db.session.commit()
    return jsonify(_serialize(user))


@user_bp.delete("/<user_id>")
@require_roles("ADMIN")
def delete_user(user_id):
    caller = load_current_user()
    user = db.session.get(User, user_id)
    if not user:
        raise AppError("Employee not found.", 404)
    if user.id == caller.id:
        raise AppError("You can't delete your own account.", 400)
    if user.role == "ADMIN" and _remaining_admins(user.id) == 0:
        raise AppError("Can't delete the last active admin.", 400)
    db.session.delete(user)
    db.session.commit()
    embedding_index.invalidate()
    return jsonify({"deleted": True, "id": user_id})
