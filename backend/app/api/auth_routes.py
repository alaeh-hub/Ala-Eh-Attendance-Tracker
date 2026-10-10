from flask import Blueprint, current_app, jsonify, request
from flask_jwt_extended import create_access_token, get_jwt_identity, jwt_required

from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.user import User
from app.services.auth_service import authenticate, issue_tokens, register_user, verify_user_password
from app.utils.auth import load_current_user, require_roles
from app.utils.validators import is_valid_email, is_valid_password

auth_bp = Blueprint("auth", __name__)


@auth_bp.post("/register")
def register():
    """Self-service sign-up. Off by default: a company adds employees through the Enroll page."""
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        raise AppError("A JSON object is required.", 400)
    if data.get("role", "STAFF") != "STAFF":
        raise AppError("Only an administrator can assign elevated roles.", 403)
    if not current_app.config.get("ALLOW_PUBLIC_REGISTRATION"):
        raise AppError("Self-registration is disabled. Ask an administrator to add you.", 403)

    full_name = data.get("full_name") if isinstance(data.get("full_name"), str) else ""
    email = data.get("email") if isinstance(data.get("email"), str) else ""
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    full_name = full_name.strip()
    email = email.strip().lower()
    if not full_name or len(full_name) > 120 or not is_valid_email(email) or not is_valid_password(password):
        raise AppError("A name of up to 120 characters, a valid email, and an 8-72 byte password are required.", 400)

    user = register_user(full_name, email, password, "STAFF")
    return jsonify(issue_tokens(user)), 201


@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        raise AppError("A JSON object is required.", 400)
    email = data.get("email") if isinstance(data.get("email"), str) else ""
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    user = authenticate(email.strip().lower(), password)
    return jsonify(issue_tokens(user)), 200


@auth_bp.post("/refresh")
@jwt_required(refresh=True)
def refresh():
    user = db.session.get(User, get_jwt_identity())
    if not user or not user.is_active or not user.can_login:
        raise AppError("Session expired.", 401)
    claims = {"role": user.role, "full_name": user.full_name}
    return jsonify({"access_token": create_access_token(identity=user.id, additional_claims=claims),
                    "user": user.to_dict()})


@auth_bp.post("/verify-password")
@require_roles("ADMIN", "OPERATOR")
def verify_current_password():
    """Re-check the signed-in user's password without issuing new tokens.
    The kiosk uses it to guard the way back into the admin portal."""
    user = load_current_user()
    data = request.get_json(silent=True) or {}
    password = data.get("password") if isinstance(data, dict) and isinstance(data.get("password"), str) else ""
    verify_user_password(user, password)
    return jsonify({"ok": True})


@auth_bp.get("/me")
@require_roles()
def me():
    # require_roles() re-checks is_active on every call, so a session that
    # was deactivated after login gets logged out on its next reload.
    return jsonify(load_current_user().to_dict())
