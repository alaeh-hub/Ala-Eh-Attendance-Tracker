import uuid
from datetime import datetime

from app.extensions import db
from app.models.user import iso_utc


class ScanSnapshot(db.Model):
    """
    One frame kept from a kiosk check-in, for audit and review.

    Matched check-ins keep their frame next to the attendance event so a
    disputed punch can be checked by eye. Unmatched / uncertain / suspected
    spoof scans form the admin review queue, where a good frame of a real
    employee can be added as a new enrollment sample. The JPEG is
    encrypted at rest when FACE_DATA_KEY is set.
    """
    __tablename__ = "scan_snapshots"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # Matched employee (MATCHED / LIVENESS_FAILED); deleted with the employee.
    user_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=True, index=True)
    # Closest enrolled employee for an unmatched scan — a hint, not an identity.
    candidate_user_id = db.Column(db.String(36), nullable=True)
    event_id = db.Column(db.String(36), nullable=True, index=True)

    status = db.Column(db.String(20), nullable=False, index=True)
    score = db.Column(db.Float, nullable=True)
    runner_up_score = db.Column(db.Float, nullable=True)
    spoof_score = db.Column(db.Float, nullable=True)
    device_id = db.Column(db.String(80), nullable=True)
    image = db.Column(db.LargeBinary, nullable=False)

    # NULL = still pending review; ADDED | DISMISSED once an admin acted.
    resolution = db.Column(db.String(12), nullable=True)
    reviewed_by = db.Column(db.String(36), nullable=True)
    reviewed_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)

    def to_dict(self, names: dict | None = None):
        names = names or {}
        return {
            "id": self.id,
            "status": self.status,
            "score": round(self.score, 4) if self.score is not None else None,
            "runner_up_score": round(self.runner_up_score, 4) if self.runner_up_score is not None else None,
            "spoof_score": round(self.spoof_score, 3) if self.spoof_score is not None else None,
            "device_id": self.device_id,
            "user_id": self.user_id,
            "user_name": names.get(self.user_id),
            "candidate_user_id": self.candidate_user_id,
            "candidate_name": names.get(self.candidate_user_id),
            "event_id": self.event_id,
            "resolution": self.resolution,
            "created_at": iso_utc(self.created_at),
        }
