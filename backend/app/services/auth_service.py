import logging
from datetime import timedelta

from flask import current_app
from flask_jwt_extended import create_access_token, create_refresh_token
from sqlalchemy.exc import IntegrityError
from app.extensions import db
from app.models.user import User
from app.utils.auth import KIOSK_ROLE
from app.utils.ratelimit import check_login_lockout, client_ip, record_login_failure, record_login_success
from app.utils.security import burn_password_check, hash_password, verify_password
from app.middleware.error_handler import AppError

logger = logging.getLogger("app.auth")

# Stored for employees who clock in by face but have no web sign-in.
# Not a valid bcrypt hash, so verify_password() always rejects it.
NO_LOGIN_HASH = "!no-login"


def register_user(full_name: str, email: str, password: str | None, role: str = "STAFF", **profile) -> User:
    if User.query.filter_by(email=email).first():
        raise AppError("A user with this email already exists.", 409)

    user = User(
        full_name=full_name,
        email=email,
        password_hash=hash_password(password) if password else NO_LOGIN_HASH,
        role=role,
        **profile,
    )
    db.session.add(user)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise AppError("A user with this email or employee ID already exists.", 409)
    return user


def authenticate(email: str, password: str) -> User:
    """
    Check a sign-in. The per-email lockout is checked first (even for
    unknown emails, so a locked-out response says nothing about whether the
    account exists), and only failures count towards it. Accounts that
    don't exist or have no password still cost one bcrypt check, so timing
    does not reveal registered emails either. Deactivation is only reported
    after the password is proven correct.
    """
    check_login_lockout(email)
    user = User.query.filter_by(email=email).first()
    if user is not None and user.can_login:
        ok = verify_password(password, user.password_hash)
    else:
        burn_password_check(password)
        ok = False
    if not ok:
        record_login_failure(email)
        # Never log the password; email + address are enough to spot
        # brute-force attempts or a mistyped account.
        logger.warning("login failed email=%s ip=%s", email, client_ip())
        raise AppError("Invalid email or password.", 401)
    record_login_success(email)
    if not user.is_active:
        logger.warning("login rejected user=%s reason=deactivated ip=%s", user.id, client_ip())
        raise AppError("This account has been deactivated.", 403)
    logger.info("login ok user=%s role=%s ip=%s", user.id, user.role, client_ip())
    return user


def verify_user_password(user: User, password: str) -> None:
    """Re-check the password of someone who is already signed in (to guard a
    sensitive action). A wrong password is 403, not 401: the session itself is
    fine, and a 401 would make the web app try to refresh the session and
    replay the request, counting every typo as two failed attempts."""
    if not password or not verify_password(password, user.password_hash):
        logger.warning("password re-check failed user=%s ip=%s", user.id, client_ip())
        raise AppError("Incorrect password.", 403, {"code": "WRONG_PASSWORD"})


def session_kiosk(user: User, requested: bool) -> bool:
    """A KIOSK device account is always kiosk-locked; others only when asked."""
    return bool(requested) or user.role == KIOSK_ROLE


def create_access(user: User, kiosk: bool) -> str:
    claims = {"role": user.role, "full_name": user.full_name, "tv": user.token_version or 0, "kiosk": bool(kiosk)}
    return create_access_token(identity=user.id, additional_claims=claims)


def create_refresh(user: User, kiosk: bool) -> tuple[str, int]:
    """Returns (token, lifetime in seconds). Kiosk sessions live KIOSK_REFRESH_DAYS
    so a wall-mounted tablet isn't signed out every week."""
    cfg = current_app.config
    if kiosk:
        lifetime = timedelta(days=int(cfg.get("KIOSK_REFRESH_DAYS", 30)))
    else:
        lifetime = cfg["JWT_REFRESH_TOKEN_EXPIRES"]
    token = create_refresh_token(identity=user.id, expires_delta=lifetime,
                                 additional_claims={"tv": user.token_version or 0, "kiosk": bool(kiosk)})
    return token, int(lifetime.total_seconds())


def session_body(user: User, kiosk: bool, access_token: str | None = None) -> dict:
    """The JSON every token-issuing endpoint returns. The refresh token is
    never in the body: it travels only as an httpOnly cookie."""
    return {
        "access_token": access_token or create_access(user, kiosk),
        "user": user.to_dict(),
        "kiosk_locked": bool(kiosk),
    }
