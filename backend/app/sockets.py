"""Socket.IO: only authenticated dashboards receive live attendance events."""
from flask_jwt_extended import decode_token
from flask_socketio import join_room

from app.extensions import db, socketio
from app.models.user import User


@socketio.on("connect")
def on_connect(auth=None):
    token = (auth or {}).get("token") if isinstance(auth, dict) else None
    if not token:
        return False
    try:
        claims = decode_token(token)
        if claims.get("type") != "access":
            return False
        user = db.session.get(User, claims["sub"])
    except Exception:
        return False
    if not user or not user.is_active or user.role not in ("ADMIN", "OPERATOR"):
        return False
    join_room("dashboards")
    return True
