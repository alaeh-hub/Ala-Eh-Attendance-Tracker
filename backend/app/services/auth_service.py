import logging

from flask_jwt_extended import create_access_token, create_refresh_token
from sqlalchemy.exc import IntegrityError
from app.extensions import db
from app.models.user import User
from app.utils.security import hash_password, verify_password
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
    user = User.query.filter_by(email=email).first()
    if not user or not verify_password(password, user.password_hash):
        # Never log the password; the email alone is enough to spot
        # brute-force attempts or a mistyped account.
        logger.warning("login failed email=%s", email)
        raise AppError("Invalid email or password.", 401)
    if not user.is_active:
        logger.warning("login rejected user=%s reason=deactivated", user.id)
        raise AppError("This account has been deactivated.", 403)
    logger.info("login ok user=%s role=%s", user.id, user.role)
    return user


def verify_user_password(user: User, password: str) -> None:
    """Re-check the password of someone who is already signed in (to guard a
    sensitive action). A wrong password is 403, not 401: the session itself is
    fine, and a 401 would make the web app try to refresh the session and
    replay the request, counting every typo as two failed attempts."""
    if not password or not verify_password(password, user.password_hash):
        logger.warning("password re-check failed user=%s", user.id)
        raise AppError("Incorrect password.", 403)


def issue_tokens(user: User) -> dict:
    claims = {"role": user.role, "full_name": user.full_name}
    return {
        "access_token": create_access_token(identity=user.id, additional_claims=claims),
        "refresh_token": create_refresh_token(identity=user.id, additional_claims=claims),
        "user": user.to_dict(),
    }
