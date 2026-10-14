"""
Sign-in, session refresh and kiosk lock.

Tokens: the short-lived access token is returned in the JSON body and kept
only in the page's memory. The refresh token is set as an httpOnly cookie
scoped to /api/auth (JS, and therefore XSS, can't read it) with a
double-submit CSRF cookie: a cookie-based refresh must echo the
`csrf_refresh_token` cookie in the X-CSRF-TOKEN header. Tools and tests may
send the refresh token as a Bearer header instead.
"""
import logging

from flask import Blueprint, current_app, jsonify, request
from flask_jwt_extended import decode_token, get_jwt, get_jwt_identity, set_refresh_cookies, unset_jwt_cookies
from flask_jwt_extended import verify_jwt_in_request

from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.user import User
from app.services.auth_service import (
    authenticate,
    create_refresh,
    register_user,
    session_body,
    session_kiosk,
    verify_user_password,
)
from app.utils.audit import log_action
from app.utils.auth import KIOSK_ROLE, is_kiosk_locked, load_current_user, require_roles, revoke_token
from app.utils.ratelimit import RateLimited, rate_limit, rate_limited_response, user_key
from app.utils.validators import is_valid_email, is_valid_password

auth_bp = Blueprint("auth", __name__)
logger = logging.getLogger("app.auth")

# 429s carry a Retry-After header, which the generic AppError handler can't
# add. Registered app-wide because every rate-limited route raises it.
auth_bp.app_errorhandler(RateLimited)(rate_limited_response)


def _session_response(user: User, kiosk: bool, status: int = 200):
    """JSON body with a new access token, plus a new refresh cookie."""
    refresh_token, max_age = create_refresh(user, kiosk)
    response = jsonify(session_body(user, kiosk))
    response.status_code = status
    set_refresh_cookies(response, refresh_token, max_age=max_age)
    return response


def _decode_quietly(token: str | None) -> dict | None:
    """Decode a JWT without raising (expired/invalid/garbage -> None). No CSRF check."""
    if not token:
        return None
    try:
        return decode_token(token)
    except Exception:
        return None


def _refresh_cookie_payload() -> dict | None:
    return _decode_quietly(request.cookies.get(current_app.config.get("JWT_REFRESH_COOKIE_NAME", "refresh_token_cookie")))


def _bearer_payload() -> dict | None:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    return _decode_quietly(header[len("Bearer "):].strip())


def _revoke_current_session(user_id: str):
    """Revoke the access token of this request and the refresh cookie, when they belong to `user_id`."""
    revoke_token(get_jwt())
    old_refresh = _refresh_cookie_payload()
    if old_refresh and old_refresh.get("sub") == user_id and old_refresh.get("type") == "refresh":
        revoke_token(old_refresh)


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
    return _session_response(user, kiosk=False, status=201)


@auth_bp.post("/login")
@rate_limit("login", limit=10, per=60)
def login():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        raise AppError("A JSON object is required.", 400)
    email = data.get("email") if isinstance(data.get("email"), str) else ""
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    user = authenticate(email.strip().lower(), password)
    return _session_response(user, kiosk=session_kiosk(user, False))


@auth_bp.post("/refresh")
@rate_limit("refresh", limit=60, per=60)
def refresh():
    """
    New access token from the refresh token. The cookie is preferred when
    present (CSRF header required); otherwise a Bearer refresh token. The
    browser's Authorization header may carry an access token on this same
    request, so the cookie must win or the call would fail on token type.
    Revocation (logout, token_version) is checked by the blocklist loader.
    """
    cookie_name = current_app.config.get("JWT_REFRESH_COOKIE_NAME", "refresh_token_cookie")
    location = "cookies" if request.cookies.get(cookie_name) else "headers"
    verify_jwt_in_request(refresh=True, locations=[location])
    user = db.session.get(User, get_jwt_identity())
    if not user or not user.is_active or not user.can_login:
        raise AppError("Session expired.", 401)
    kiosk = session_kiosk(user, get_jwt().get("kiosk"))
    return jsonify(session_body(user, kiosk))


@auth_bp.post("/logout")
def logout():
    """Sign out: blocklist the refresh token (cookie or Bearer) and the access
    token if one is sent, and clear the cookies. Never fails, so a stale or
    expired session can always sign out."""
    for payload in (_refresh_cookie_payload(), _bearer_payload()):
        if payload:
            revoke_token(payload)
    db.session.commit()
    response = jsonify({"ok": True})
    unset_jwt_cookies(response)
    return response


@auth_bp.post("/kiosk/lock")
@require_roles("ADMIN", "OPERATOR", KIOSK_ROLE, allow_kiosk=True)
def kiosk_lock():
    """Turn this browser's session into a kiosk-locked one: from now on the
    server only accepts it for check-in until an admin/operator unlocks it
    with their password. Idempotent for an already locked session."""
    user = load_current_user()
    was_locked = is_kiosk_locked()
    _revoke_current_session(user.id)
    if not was_locked:
        log_action(user.id, "KIOSK_LOCKED", "user", user.id, {"ip": request.remote_addr})
    db.session.commit()
    return _session_response(user, kiosk=True)


@auth_bp.post("/kiosk/unlock")
@require_roles(allow_kiosk=True)
@rate_limit("kiosk-unlock", limit=5, per=60, key=user_key)
def kiosk_unlock():
    """Leave kiosk mode. Needs the signed-in admin/operator's password; a
    KIOSK device account can never leave it."""
    user = load_current_user()
    if user.role not in ("ADMIN", "OPERATOR"):
        raise AppError("This kiosk account can't leave kiosk mode. Sign out instead.", 403, {"code": "KIOSK_ACCOUNT"})
    data = request.get_json(silent=True)
    password = data.get("password") if isinstance(data, dict) and isinstance(data.get("password"), str) else ""
    try:
        verify_user_password(user, password)
    except AppError:
        log_action(user.id, "KIOSK_UNLOCK_FAILED", "user", user.id, {"ip": request.remote_addr})
        db.session.commit()
        raise
    _revoke_current_session(user.id)
    log_action(user.id, "KIOSK_UNLOCKED", "user", user.id, {"ip": request.remote_addr})
    db.session.commit()
    return _session_response(user, kiosk=False)


@auth_bp.post("/verify-password")
@require_roles("ADMIN", "OPERATOR")
@rate_limit("verify-password", limit=5, per=60, key=user_key)
def verify_current_password():
    """Re-check the signed-in user's password without issuing new tokens."""
    user = load_current_user()
    data = request.get_json(silent=True) or {}
    password = data.get("password") if isinstance(data, dict) and isinstance(data.get("password"), str) else ""
    verify_user_password(user, password)
    return jsonify({"ok": True})


@auth_bp.get("/me")
@require_roles(allow_kiosk=True)
def me():
    # require_roles() re-checks is_active on every call, so a session that
    # was deactivated after login gets logged out on its next reload.
    return jsonify({**load_current_user().to_dict(), "kiosk_locked": is_kiosk_locked()})
