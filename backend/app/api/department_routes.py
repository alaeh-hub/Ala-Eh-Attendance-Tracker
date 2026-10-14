import re

from flask import Blueprint, jsonify, request
from sqlalchemy import func

from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.department import Department
from app.models.user import User
from app.utils.audit import log_action
from app.utils.auth import load_current_user, require_roles

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
        if start == end:
            raise AppError(f"Shift '{name}' cannot start and end at the same time.", 400)
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


def _minutes(hhmm: str) -> int:
    hh, mm = hhmm.split(":")
    return int(hh) * 60 + int(mm)


def _validate_schedule(start: str | None, end: str | None) -> None:
    """A fixed schedule needs both ends or neither. end <= start is legal:
    it is an overnight shift (22:00-06:00 ends the next morning)."""
    if bool(start) != bool(end):
        raise AppError("Set both a start and an end time, or neither.", 400)
    if start and start == end:
        raise AppError("The shift cannot start and end at the same time.", 400)


def _break_fit(shift_start: str, shift_end: str, break_start: str, break_end: str) -> str:
    """'inside', 'outside' or 'straddles': where the break lies relative to
    the shift, with both measured as offsets from the shift start so that
    overnight shifts and breaks after midnight compare correctly."""
    s = _minutes(shift_start)
    span = (_minutes(shift_end) - s) % 1440 or 1440
    b0 = (_minutes(break_start) - s) % 1440
    b1 = b0 + ((_minutes(break_end) - _minutes(break_start)) % 1440)
    if b1 <= span:
        return "inside"
    if b0 >= span and b1 <= 1440:
        return "outside"
    return "straddles"


def _validate_break(dept_start, dept_end, shifts: list, break_start: str, break_end: str,
                    explicit: bool) -> None:
    """
    The break may cross midnight (23:30-00:30 on a night shift) but must
    fit the schedule: a break half in and half out of a shift is always an
    error. A break wholly outside a fixed schedule is an error when the
    admin set it explicitly (e.g. the default 12:00-13:00 left on a
    22:00-06:00 department). Rotating departments share one break across
    shifts, so a break outside SOME shifts is fine (it simply does not
    apply to them).
    """
    if break_start == break_end:
        raise AppError("Break end must be after break start.", 400)
    if dept_start and dept_end:
        fit = _break_fit(dept_start, dept_end, break_start, break_end)
        if fit == "straddles" or (fit == "outside" and explicit):
            raise AppError(f"The {break_start}-{break_end} break must fall inside the "
                           f"{dept_start}-{dept_end} working hours.", 400)
    for shift in shifts:
        if _break_fit(shift["start_time"], shift["end_time"], break_start, break_end) == "straddles":
            raise AppError(f"The {break_start}-{break_end} break overlaps the start or end of the "
                           f"'{shift['name']}' shift ({shift['start_time']}-{shift['end_time']}).", 400)


def _schedule_snapshot(dept: Department) -> dict:
    """Everything about a department that affects attendance, for audit before/after."""
    return {
        "name": dept.name,
        "start_time": dept.start_time,
        "end_time": dept.end_time,
        "break_start": dept.break_start,
        "break_end": dept.break_end,
        "has_shifting": dept.has_shifting,
        "shifts": dept.shifts,
        "roles": dept.roles,
    }


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

    start_time = None if has_shifting else _clean_time(data.get("start_time"), "Start time")
    end_time = None if has_shifting else _clean_time(data.get("end_time"), "End time")
    _validate_schedule(start_time, end_time)

    break_start = _clean_time(data.get("break_start", "12:00"), "Break start") or "12:00"
    break_end = _clean_time(data.get("break_end", "13:00"), "Break end") or "13:00"
    _validate_break(start_time, end_time, shifts, break_start, break_end,
                    explicit="break_start" in data or "break_end" in data)

    dept = Department(
        name=name,
        has_shifting=has_shifting,
        start_time=start_time,
        end_time=end_time,
        break_start=break_start,
        break_end=break_end,
    )
    dept.shifts = shifts
    dept.roles = _clean_roles(data.get("roles"))

    db.session.add(dept)
    db.session.flush()
    log_action(load_current_user().id, "DEPARTMENT_CREATED", "department", dept.id,
               {"after": _schedule_snapshot(dept)})
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

    before = _schedule_snapshot(dept)
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

    break_given = "break_start" in data or "break_end" in data
    if break_given:
        dept.break_start = _clean_time(data.get("break_start", dept.break_start), "Break start") or "12:00"
        dept.break_end = _clean_time(data.get("break_end", dept.break_end), "Break end") or "13:00"
    schedule_keys = ("start_time", "end_time", "has_shifting", "shifts", "break_start", "break_end")
    if any(k in data for k in schedule_keys):
        # Validate the department as it will be saved, not just the fields
        # sent; nothing is committed if this raises.
        _validate_schedule(dept.start_time, dept.end_time)
        _validate_break(dept.start_time, dept.end_time, dept.shifts if dept.has_shifting else [],
                        dept.break_start or "12:00", dept.break_end or "13:00", explicit=break_given)

    # Keep existing employees' free-text department column in sync with a rename.
    if dept.name != old_name:
        User.query.filter(User.department == old_name).update({User.department: dept.name})

    after = _schedule_snapshot(dept)
    changed = {k: {"before": before[k], "after": after[k]} for k in after if before[k] != after[k]}
    if changed:
        # Past attendance keeps the schedule stamped on each punch; this
        # trail records when (and by whom) the rules changed.
        log_action(load_current_user().id, "DEPARTMENT_UPDATED", "department", dept.id,
                   {"name": dept.name, "changes": changed, "before": before, "after": after})
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
    log_action(load_current_user().id, "DEPARTMENT_DELETED", "department", dept.id,
               {"before": _schedule_snapshot(dept)})
    db.session.delete(dept)
    db.session.commit()
    return jsonify({"deleted": True, "id": dept_id})
