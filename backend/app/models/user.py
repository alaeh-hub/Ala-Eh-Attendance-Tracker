import uuid
from datetime import datetime
from app.extensions import db


def iso_utc(value: datetime | None) -> str | None:
    """All timestamps are stored as naive UTC; emit them with a Z so browsers convert correctly."""
    return value.isoformat() + "Z" if value else None


class User(db.Model):
    """
    A person in the organisation. Every employee who clocks in is a User;
    only those given a password (admins, operators, or staff with portal
    access) can sign in to the web app.
    """
    __tablename__ = "users"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    full_name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)

    # ADMIN | STAFF | OPERATOR | KIOSK. KIOSK is a device account for a
    # check-in tablet: it signs in with a password but its sessions are
    # always kiosk-locked (see app/utils/auth.py).
    role = db.Column(db.String(20), nullable=False, default="STAFF")

    # --- Employee profile ---
    employee_code = db.Column(db.String(40), unique=True, nullable=True, index=True)
    department = db.Column(db.String(80), nullable=True)
    position = db.Column(db.String(80), nullable=True)
    phone = db.Column(db.String(40), nullable=True)
    # Small JPEG face thumbnail taken from the best frontal enrollment sample.
    photo = db.Column(db.LargeBinary, nullable=True)

    # Biometric consent: when an admin recorded that the employee agreed to
    # have their face enrolled, and who recorded it.
    biometric_consent_at = db.Column(db.DateTime, nullable=True)
    biometric_consent_by = db.Column(db.String(36), nullable=True)

    is_active = db.Column(db.Boolean, default=True, nullable=False)
    # Embedded in every JWT as the "tv" claim. Bumping it (password change,
    # sign-in revoked, deactivation, role change, archive) invalidates every
    # token issued before, without tracking them individually.
    token_version = db.Column(db.Integer, nullable=False, default=0, server_default="0")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    embeddings = db.relationship("FaceEmbedding", backref="user", cascade="all, delete-orphan")
    # Attendance is a payroll record and must outlive the account: deleting a
    # User never touches its events (passive_deletes="all" stops SQLAlchemy
    # from deleting or nulling them). The users API archives an employee who
    # has attendance instead of deleting them; see user_routes.delete_user.
    attendance_events = db.relationship("AttendanceEvent", backref="user", cascade="save-update, merge",
                                        passive_deletes="all")
    snapshots = db.relationship("ScanSnapshot", foreign_keys="ScanSnapshot.user_id", cascade="all, delete-orphan")

    def revoke_tokens(self):
        """Invalidate every access/refresh token issued to this user so far."""
        self.token_version = (self.token_version or 0) + 1

    @property
    def can_login(self) -> bool:
        return bool(self.password_hash) and self.password_hash.startswith("$2")

    def to_dict(self, sample_count: int | None = None):
        count = len(self.embeddings) if sample_count is None else sample_count
        return {
            "id": self.id,
            "full_name": self.full_name,
            "email": self.email,
            "role": self.role,
            "employee_code": self.employee_code,
            "department": self.department,
            "position": self.position,
            "phone": self.phone,
            "has_photo": self.photo is not None,
            "can_login": self.can_login,
            "is_active": self.is_active,
            "consent_recorded": self.biometric_consent_at is not None,
            "enrolled": count > 0,
            "sample_count": count,
            "created_at": iso_utc(self.created_at),
        }
