import uuid
from datetime import datetime
from app.extensions import db


class AuditLog(db.Model):
    __tablename__ = "audit_logs"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    actor_user_id = db.Column(db.String(36), nullable=True)
    action = db.Column(db.String(80), nullable=False)  # e.g. "USER_CREATED", "ATTENDANCE_CORRECTED"
    target_type = db.Column(db.String(40), nullable=True)
    target_id = db.Column(db.String(36), nullable=True)
    details = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "actor_user_id": self.actor_user_id,
            "action": self.action,
            "target_type": self.target_type,
            "target_id": self.target_id,
            "details": self.details,
            "created_at": self.created_at.isoformat() + "Z" if self.created_at else None,
        }
