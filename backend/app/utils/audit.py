import json

from app.extensions import db
from app.models.audit_log import AuditLog


def log_action(actor_id: str | None, action: str, target_type: str | None = None,
               target_id: str | None = None, details: dict | None = None):
    """Adds an audit row to the current session; the caller commits."""
    db.session.add(AuditLog(
        actor_user_id=actor_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        details=json.dumps(details, default=str) if details else None,
    ))
