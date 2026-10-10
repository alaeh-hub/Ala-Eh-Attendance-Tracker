import re

from flask import Blueprint, jsonify, request
from sqlalchemy import func

from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.department import Department
from app.models.user import User
from app.utils.auth import require_roles

department_bp = Blueprint("departments", __name__)

TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def _clean_name(value) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AppError("A department name is required.", 400)
    return value.strip()[:80]


def _clean_time(value, field: str):
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not TIME_RE.match(value):
        raise AppError(f"{field} must be a 24-hour time like 08:00.", 400)
    return value


def _clean_bool(value, field: str) -> bool:
    if not isinstance(value, bool):
        raise AppError(f"{field} must be a boolean.", 400)
    return value


def _clean_shifts(value) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise AppError("shifts must be a list.", 400)
    cleaned = []
    for i, shift in enumerate(value):
        if not isinstance(shift, dict):
            raise AppError(f"Shift #{i + 1} is invalid.", 400)
        name = shift.get("name")
        if not isinstance(name, str) or not name.strip():
            raise AppError(f"Shift #{i + 1} needs a name.", 400)
        start = _clean_time(shift.get("start_time"), f"Shift '{name}' start time")
        end = _clean_time(shift.get("end_time"), f"Shift '{name}' end time")
        if not start or not end:
            raise AppError(f"Shift '{name}' needs a start and end time.", 400)
        cleaned.append({"name": name.strip()[:40], "start_time": start, "end_time": end})
    return cleaned


def _clean_roles(value) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise AppError("roles must be a list.", 400)
    cleaned = []
    seen = set()
    for i, role in enumerate(value):
        if not isinstance(role, str) or not role.strip():
            raise AppError(f"Role #{i + 1} is invalid.", 400)
        name = role.strip()[:60]
        if name.lower() not in seen:
            seen.add(name.lower())
            cleaned.append(name)
    return cleaned


def _validate_name(name: str, exclude_id: str | None = None) -> str:
    q = Department.query.filter(func.lower(Department.name) == name.lower())
    if exclude_id:
        q = q.filter(Department.id != exclude_id)
    if q.first():
        raise AppError(f"A department named '{name}' already exists.", 409)
    return name


def _employee_counts() -> dict:
    rows = db.session.query(User.department, func.count(User.id)).filter(User.department.isnot(None)).group_by(User.department).all()
    return dict(rows)


def _serialize(dept: Department, counts: dict | None = None) -> dict:
    counts = counts if counts is not None else _employee_counts()
    return dept.to_dict(employee_count=counts.get(dept.name, 0))


@department_bp.get("")
@require_roles("ADMIN", "OPERATOR")
def list_departments():
    depts = Department.query.order_by(Department.name).all()
    counts = _employee_counts()
    return jsonify([_serialize(d, counts) for d in depts])


@department_bp.post("")
@require_roles("ADMIN")
def create_department():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise AppError("A JSON object is required.", 400)

    name = _validate_name(_clean_name(data.get("name")))
    has_shifting = _clean_bool(data.get("has_shifting", False), "has_shifting")
    shifts = _clean_shifts(data.get("shifts")) if has_shifting else []
    if has_shifting and not shifts:
        raise AppError("Add at least one shift, or turn off shifting.", 400)

    break_start = _clean_time(data.get("break_start", "12:00"), "Break start") or "12:00"
    break_end = _clean_time(data.get("break_end", "13:00"), "Break end") or "13:00"
    if break_end <= break_start:
        raise AppError("Break end must be after break start.", 400)

    dept = Department(
        name=name,
        has_shifting=has_shifting,
        start_time=None if has_shifting else _clean_time(data.get("start_time"), "Start time"),
        end_time=None if has_shifting else _clean_time(data.get("end_time"), "End time"),
        break_start=break_start,
        break_end=break_end,
    )
    dept.shifts = shifts
    dept.roles = _clean_roles(data.get("roles"))

    db.session.add(dept)
    db.session.commit()
    return jsonify(_serialize(dept)), 201


@department_bp.patch("/<dept_id>")
@require_roles("ADMIN")
def update_department(dept_id):
    dept = db.session.get(Department, dept_id)
    if not dept:
        raise AppError("Department not found.", 404)

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise AppError("A JSON object is required.", 400)

    old_name = dept.name
    if "name" in data:
        dept.name = _validate_name(_clean_name(data["name"]), exclude_id=dept.id)

    has_shifting = _clean_bool(data["has_shifting"], "has_shifting") if "has_shifting" in data else dept.has_shifting
    if "shifts" in data or "has_shifting" in data:
        shifts = _clean_shifts(data.get("shifts", dept.shifts)) if has_shifting else []
        if has_shifting and not shifts:
            raise AppError("Add at least one shift, or turn off shifting.", 400)
        dept.shifts = shifts
    dept.has_shifting = has_shifting

    if "start_time" in data:
        dept.start_time = None if has_shifting else _clean_time(data["start_time"], "Start time")
    if "end_time" in data:
        dept.end_time = None if has_shifting else _clean_time(data["end_time"], "End time")
    if has_shifting:
        dept.start_time = None
        dept.end_time = None

    if "roles" in data:
        dept.roles = _clean_roles(data["roles"])

    if "break_start" in data or "break_end" in data:
        break_start = _clean_time(data.get("break_start", dept.break_start), "Break start") or "12:00"
        break_end = _clean_time(data.get("break_end", dept.break_end), "Break end") or "13:00"
        if break_end <= break_start:
            raise AppError("Break end must be after break start.", 400)
        dept.break_start = break_start
        dept.break_end = break_end

    # Keep existing employees' free-text department column in sync with a rename.
    if dept.name != old_name:
        User.query.filter(User.department == old_name).update({User.department: dept.name})

    db.session.commit()
    return jsonify(_serialize(dept))


@department_bp.delete("/<dept_id>")
@require_roles("ADMIN")
def delete_department(dept_id):
    dept = db.session.get(Department, dept_id)
    if not dept:
        raise AppError("Department not found.", 404)
    in_use = User.query.filter(User.department == dept.name).count()
    if in_use:
        raise AppError(f"{in_use} employee(s) are assigned to this department. Reassign them first.", 409)
    db.session.delete(dept)
    db.session.commit()
    return jsonify({"deleted": True, "id": dept_id})
