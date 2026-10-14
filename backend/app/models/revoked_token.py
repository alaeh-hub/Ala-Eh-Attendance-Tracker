from datetime import datetime

from app.extensions import db


class RevokedToken(db.Model):
    """
    A signed-out JWT that must be refused until it would have expired
    anyway (logout, kiosk lock/unlock). Rows past `expires_at` are useless
    and are purged opportunistically whenever a new one is added.

    Revoking every session of a user at once (password change, deactivation,
    role change) does not go through this table: that bumps
    `users.token_version` instead.
    """
    __tablename__ = "revoked_tokens"

    jti = db.Column(db.String(36), primary_key=True)
    token_type = db.Column(db.String(10), nullable=False)  # access | refresh
    user_id = db.Column(db.String(36), nullable=True, index=True)
    expires_at = db.Column(db.DateTime, nullable=False, index=True)  # naive UTC
    revoked_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
