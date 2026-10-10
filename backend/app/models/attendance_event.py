import uuid
from datetime import datetime
from app.extensions import db
from app.models.user import iso_utc


class AttendanceEvent(db.Model):
    __tablename__ = "attendance_events"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=False, index=True)

    event_type = db.Column(db.String(10), nullable=False)  # CLOCK_IN | CLOCK_OUT
    # AM = 12am-12pm, PM = 12pm-12am (org-local time), decided automatically
    # from the clock. OT (overtime) is never automatic — it's only written
    # when the kiosk operator explicitly selects OT In/OT Out. Each session
    # alternates its own CLOCK_IN/CLOCK_OUT, giving the classic 4-punch DTR
    # (AM in, AM out for lunch, PM in, PM out) plus an optional OT in/out pair.
    session = db.Column(db.String(2), nullable=False, default="AM")
    # Naive UTC.
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)

    match_score = db.Column(db.Float, nullable=False)
    match_status = db.Column(db.String(20), nullable=False)  # MATCHED | MANUAL
    liveness_passed = db.Column(db.Boolean, default=False)

    device_id = db.Column(db.String(80), nullable=True)
    notes = db.Column(db.String(255), nullable=True)

    def to_dict(self):
        user = self.user
        return {
            "id": self.id,
            "user_id": self.user_id,
            "user_name": user.full_name if user else None,
            "employee_code": user.employee_code if user else None,
            "department": user.department if user else None,
            "has_photo": bool(user and user.photo is not None),
            "event_type": self.event_type,
            "session": self.session,
            "timestamp": iso_utc(self.timestamp),
            "match_score": round(self.match_score, 4),
            "match_status": self.match_status,
            "liveness_passed": self.liveness_passed,
            "device_id": self.device_id,
            "notes": self.notes,
        }
