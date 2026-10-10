from functools import wraps

from flask import g
from flask_jwt_extended import get_jwt_identity, verify_jwt_in_request

from app.middleware.error_handler import AppError


def load_current_user():
    """
    Verify the JWT, then load the user fresh from the database instead of
    trusting the role/name baked into the token at login time.

    The old pattern (`get_jwt().get("role")`) read claims that are frozen
    the moment a token is issued. With an 8-hour access token, that meant
    deactivating a user or changing their role had NO effect until their
    existing token expired — a deactivated employee, or an admin demoted
    to STAFF, kept full access for up to 8 hours. Re-querying the user on
    every request closes that gap: a deactivation or role change applies
    on the very next request.
    """
    from app.extensions import db
    from app.models.user import User  # local import avoids a circular import at module load

    if "current_user" not in g:
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
    return g.current_user


def require_roles(*roles):
    """
    Route decorator: require a valid, active session, and (if any roles
    are given) that the CURRENT database role is one of them. Replaces
    bare `@jwt_required()` on every route that used to read the role off
    the token — see load_current_user() for why that mattered.
    """

    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = load_current_user()
            if roles and user.role not in roles:
                raise AppError("You don't have permission to do that.", 403)
            return fn(*args, **kwargs)

        return wrapper

    return decorator
