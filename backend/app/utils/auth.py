from datetime import datetime, timezone
from functools import wraps

from flask import g, request
from flask_jwt_extended import get_jwt, get_jwt_identity, verify_jwt_in_request

from app.middleware.error_handler import AppError

KIOSK_ROLE = "KIOSK"


def token_revoked(payload: dict) -> bool:
    """
    True when a decoded JWT must no longer be honoured: it was signed out
    individually (revoked_tokens), its user is gone, or the user's
    token_version moved past the `tv` the token was issued with (password
    change, sign-in revoked, deactivation, role change, archive).

    Registered as flask-jwt-extended's blocklist check, so it runs for every
    protected request and for /auth/refresh; sockets call it directly.
    Tokens minted before the `tv` claim existed count as version 0.
    """
    from app.extensions import db
    from app.models.revoked_token import RevokedToken
    from app.models.user import User

    jti = payload.get("jti")
    if jti and db.session.get(RevokedToken, jti) is not None:
        return True
    user = db.session.get(User, payload.get("sub"))
    if user is None:
        return True
    try:
        return int(payload.get("tv", 0)) != (user.token_version or 0)
    except (TypeError, ValueError):
        return True


def revoke_token(payload: dict | None):
    """Add one decoded token to the blocklist (caller commits). Also purges rows that have expired."""
    from app.extensions import db
    from app.models.revoked_token import RevokedToken

    if not payload or not payload.get("jti") or not payload.get("exp"):
        return
    now = datetime.utcnow()
    RevokedToken.query.filter(RevokedToken.expires_at < now).delete(synchronize_session=False)
    if db.session.get(RevokedToken, payload["jti"]) is None:
        expires = datetime.fromtimestamp(payload["exp"], tz=timezone.utc).replace(tzinfo=None)
        db.session.add(RevokedToken(jti=payload["jti"], token_type=payload.get("type", "access"),
                                    user_id=payload.get("sub"), expires_at=expires))


def load_current_user():
    """
    Verify the JWT, then load the user fresh from the database instead of
    trusting the role/name baked into the token at login time.

    The old pattern (`get_jwt().get("role")`) read claims that are frozen
    the moment a token is issued, so a deactivation or role change had no
    effect until the token expired. Re-querying the user on every request
    applies it on the very next request; token revocation (`token_revoked`)
    is checked by verify_jwt_in_request through the blocklist loader.

    The result is cached per request. The cache remembers WHICH request it
    belongs to, so an app context shared by several requests (as in tests)
    can never hand one request's user to the next.
    """
    from app.extensions import db
    from app.models.user import User  # local import avoids a circular import at module load

    req = request._get_current_object()
    if g.get("_current_user_request") is not req or "current_user" not in g:
        g.pop("current_user", None)
        verify_jwt_in_request()
        user = db.session.get(User, get_jwt_identity())
        if not user:
            raise AppError("User not found.", 401)
        if not user.is_active:
            # Treat a deactivated account as an invalid session. This lets
            # the frontend's normal 401 handling clear its stale local session.
            raise AppError("This account has been deactivated.", 401)
        if not user.can_login:
            raise AppError("Sign-in access has been revoked.", 401)
        g.current_user = user
        g._current_user_request = req
    return g.current_user


def is_kiosk_locked() -> bool:
    """Whether the current session is locked to the kiosk. A KIOSK device
    account is always locked, whatever its token says."""
    return bool(get_jwt().get("kiosk")) or load_current_user().role == KIOSK_ROLE


def require_roles(*roles, allow_kiosk: bool = False):
    """
    Route decorator: require a valid, active session, and (if any roles
    are given) that the CURRENT database role is one of them.

    Kiosk lock is enforced here, server-side: a kiosk-locked session may
    only reach endpoints marked `allow_kiosk=True` (check-in and what the
    kiosk screen needs). Anything else is 403 KIOSK_LOCKED, so someone at
    an unattended tablet cannot reach the admin portal by editing the URL
    or calling the API with the page's token.
    """

    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = load_current_user()
            if not allow_kiosk and is_kiosk_locked():
                raise AppError("This device is locked to the kiosk.", 403, {"code": "KIOSK_LOCKED"})
            if roles and user.role not in roles:
                raise AppError("You don't have permission to do that.", 403)
            return fn(*args, **kwargs)

        return wrapper

    return decorator
