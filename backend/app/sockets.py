"""Socket.IO: only authenticated dashboards receive live attendance events."""
from flask_jwt_extended import decode_token
from flask_socketio import join_room

from app.extensions import db, socketio
from app.models.user import User
from app.utils.auth import token_revoked


def on_connect(auth=None):
    """
    The client sends `{token: <access token>}` (as a callback, so every
    reconnect uses its current token). decode_token() checks signature and
    expiry only, so revocation is checked here explicitly. Kiosk-locked
    sessions get no live feed: the tablet has no reason to see other
    employees' punches.
    """
    token = (auth or {}).get("token") if isinstance(auth, dict) else None
    if not token:
        return False
    try:
        claims = decode_token(token)
        if claims.get("type") != "access" or claims.get("kiosk") or token_revoked(claims):
            return False
        user = db.session.get(User, claims["sub"])
    except Exception:
        return False
    if not user or not user.is_active or not user.can_login or user.role not in ("ADMIN", "OPERATOR"):
        return False
    join_room("dashboards")
    return True


def _register_connect_handler():
    """
    Flask-SocketIO only remembers a handler for servers created LATER by
    init_app when it is registered before the first one exists. This module
    is imported after init_app, so without the second step a further
    create_app() in the same process (tests, scripts) would get a server
    with no connect check at all, accepting every connection.
    """
    socketio.on("connect")(on_connect)
    if socketio.server is not None and not any(event == "connect" for event, _, _ in socketio.handlers):
        socketio.handlers.append(("connect", socketio.server.handlers["/"]["connect"], "/"))


_register_connect_handler()
