import json
import uuid
from datetime import datetime

from app.extensions import db
from app.models.user import iso_utc


class Department(db.Model):
    """
    An organisational department/section. Carries its default working
    hours and (optionally) a set of named shifts for departments that
    rotate staff across different hours, plus the list of job roles
    (positions) an employee in this department can hold.
    """
    __tablename__ = "departments"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = db.Column(db.String(80), unique=True, nullable=False, index=True)

    # Default working hours, "HH:MM" 24-hour. Used directly when the
    # department has no shifting.
    start_time = db.Column(db.String(5), nullable=True)
    end_time = db.Column(db.String(5), nullable=True)

    has_shifting = db.Column(db.Boolean, default=False, nullable=False)
    # JSON-encoded list[{"name": str, "start_time": "HH:MM", "end_time": "HH:MM"}]
    shifts_json = db.Column(db.Text, nullable=True)
    # JSON-encoded list[str] of job roles/positions available in this department.
    roles_json = db.Column(db.Text, nullable=True)

    # Lunch break window, "HH:MM" 24-hour, org-local. Time inside this
    # window is never counted as worked time — whether the employee
    # actually punches out for lunch (AM-out/PM-in) or just stays clocked
    # in straight through (the overlap is subtracted from that one long
    # punch instead). Defaults to the classic 12:00-13:00 noon break.
    break_start = db.Column(db.String(5), nullable=True, default="12:00")
    break_end = db.Column(db.String(5), nullable=True, default="13:00")

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    @property
    def shifts(self) -> list:
        return json.loads(self.shifts_json) if self.shifts_json else []

    @shifts.setter
    def shifts(self, value: list):
        self.shifts_json = json.dumps(value) if value else None

    @property
    def roles(self) -> list:
        return json.loads(self.roles_json) if self.roles_json else []

    @roles.setter
    def roles(self, value: list):
        self.roles_json = json.dumps(value) if value else None

    def to_dict(self, employee_count: int | None = None) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "break_start": self.break_start,
            "break_end": self.break_end,
            "has_shifting": self.has_shifting,
            "shifts": self.shifts,
            "roles": self.roles,
            "employee_count": employee_count,
            "created_at": iso_utc(self.created_at),
        }
