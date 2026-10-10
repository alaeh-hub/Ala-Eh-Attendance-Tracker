import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from flask import current_app
from sqlalchemy import func

from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.attendance_event import AttendanceEvent
from app.models.department import Department
from app.models.user import User
from app.utils.timezone import org_day_bounds_utc, org_tz, to_org_tz, utcnow

logger = logging.getLogger("app.attendance")

EVENT_TYPES = ("CLOCK_IN", "CLOCK_OUT")
# The kiosk offers six punches — the classic 4-punch DTR plus an overtime
# pair. AM and PM are both regular-shift sessions and share a single
# in/out sequence for the day; OT runs its own sequence and is only ever
# entered explicitly.
SESSIONS = ("AM", "PM", "OT")
REGULAR_SESSIONS = ("AM", "PM")

SESSION_LABELS = {"AM": "AM", "PM": "PM", "OT": "OT"}
PUNCH_LABELS = {
    ("CLOCK_IN", "AM"): "AM time in",
    ("CLOCK_OUT", "AM"): "AM time out",
    ("CLOCK_IN", "PM"): "PM time in",
    ("CLOCK_OUT", "PM"): "PM time out",
    ("CLOCK_IN", "OT"): "OT time in",
    ("CLOCK_OUT", "OT"): "OT time out",
}


class CooldownActive(Exception):
    """Raised when a user scans again within the (short, anti-duplicate-frame) cooldown window."""

    def __init__(self, last_event: AttendanceEvent, seconds_remaining: int):
        super().__init__("cooldown")
        self.last_event = last_event
        self.seconds_remaining = seconds_remaining


class AlreadyVerified(Exception):
    """
    Raised when a scan must not write a new attendance event, because
    either (a) it falls inside the re-verification window that follows
    every punch, or (b) the punch it resolves to is already on record for
    today. Both are the same thing from the employee's side — they're
    re-confirming attendance that has already been taken, not making a
    new one — so the kiosk reassures them instead of writing a duplicate.
    """

    def __init__(self, last_event: AttendanceEvent, reason: str | None = None,
                 seconds_remaining: int | None = None):
        super().__init__("already_verified")
        self.last_event = last_event
        self.seconds_remaining = seconds_remaining
        self.reason = reason or "Identity confirmed — your attendance for this session is already recorded."


def _hhmm(value: str) -> tuple[int, int]:
    hh, mm = value.split(":")
    return int(hh), int(mm)


def _at(local_dt: datetime, hhmm: str) -> datetime:
    """`hhmm` ("HH:MM") as a datetime on local_dt's own calendar day."""
    hh, mm = _hhmm(hhmm)
    return local_dt.replace(hour=hh, minute=mm, second=0, microsecond=0)


def _pretty(hhmm: str) -> str:
    hh, mm = _hhmm(hhmm)
    return datetime(2000, 1, 1, hh, mm).strftime("%I:%M %p").lstrip("0")


def _local_time(event: AttendanceEvent) -> str:
    return to_org_tz(event.timestamp).strftime("%I:%M %p").lstrip("0")


def current_session(local_dt: datetime) -> str:
    """AM = 12am-12pm, PM = 12pm-12am, org-local time."""
    return "AM" if local_dt.hour < 12 else "PM"


def last_event_today(user_id: str) -> AttendanceEvent | None:
    start, end = org_day_bounds_utc()
    return (
        AttendanceEvent.query.filter(
            AttendanceEvent.user_id == user_id,
            AttendanceEvent.timestamp >= start,
            AttendanceEvent.timestamp < end,
        )
        .order_by(AttendanceEvent.timestamp.desc())
        .first()
    )


def events_in_session(user_id: str, session: str) -> list[AttendanceEvent]:
    start, end = org_day_bounds_utc()
    return (
        AttendanceEvent.query.filter(
            AttendanceEvent.user_id == user_id,
            AttendanceEvent.session == session,
            AttendanceEvent.timestamp >= start,
            AttendanceEvent.timestamp < end,
        )
        .order_by(AttendanceEvent.timestamp.asc())
        .all()
    )


def regular_events_today(user_id: str) -> list[AttendanceEvent]:
    """Today's AM and PM events as one ascending sequence.

    The regular shift is a single in/out chain across the whole day, not
    one chain per half. Somebody who times in at 8am and never punches for
    lunch is *still timed in* at 5pm, so their next punch is a time out —
    whichever half of the day it lands in.
    """
    start, end = org_day_bounds_utc()
    return (
        AttendanceEvent.query.filter(
            AttendanceEvent.user_id == user_id,
            AttendanceEvent.session.in_(REGULAR_SESSIONS),
            AttendanceEvent.timestamp >= start,
            AttendanceEvent.timestamp < end,
        )
        .order_by(AttendanceEvent.timestamp.asc())
        .all()
    )


def determine_event_type(user_id: str, session: str) -> str:
    """Alternates CLOCK_IN / CLOCK_OUT along today's relevant chain — the
    shared AM+PM regular chain, or the separate OT chain. The first scan
    of each chain is always a CLOCK_IN."""
    events = events_in_session(user_id, "OT") if session == "OT" else regular_events_today(user_id)
    if not events or events[-1].event_type == "CLOCK_OUT":
        return "CLOCK_IN"
    return "CLOCK_OUT"


def existing_punch(user_id: str, session: str, event_type: str) -> AttendanceEvent | None:
    """The event of this exact type already recorded for this session, if any."""
    return next((e for e in events_in_session(user_id, session) if e.event_type == event_type), None)


def punch_label(event_type: str, session: str) -> str:
    return PUNCH_LABELS.get((event_type, session), f"{session} {event_type.replace('CLOCK_', '').title()}")


def _find_department(user: User) -> Department | None:
    if not user.department:
        return None
    return Department.query.filter(func.lower(Department.name) == user.department.lower()).first()


def department_schedule(user: User) -> tuple[str | None, str | None]:
    """(start_time, end_time) as "HH:MM" strings from the employee's
    department, or (None, None) if there's no department, it's not
    found, or it rotates shifts (no single start/end to compare against)."""
    dept = _find_department(user)
    if not dept or dept.has_shifting:
        return None, None
    return dept.start_time, dept.end_time


def department_break_times(user: User) -> tuple[str, str]:
    """(break_start, break_end) as "HH:MM" strings — the employee's
    department's configured lunch window, falling back to the global
    config default when the department has none configured."""
    cfg = current_app.config
    dept = _find_department(user)
    start = (dept.break_start if dept else None) or cfg["BREAK_START"]
    end = (dept.break_end if dept else None) or cfg["BREAK_END"]
    return start, end


def shift_end_time(user: User) -> str | None:
    """The employee's "HH:MM" end of shift, or None when it can't be used:
    a rotating-shift department (no single schedule) or an overnight shift
    that ends on the next calendar day — neither can be compared against a
    wall-clock reading."""
    start, end = department_schedule(user)
    end = end or current_app.config.get("SHIFT_END") or None
    if not end:
        return None
    if start and _hhmm(end) <= _hhmm(start):
        return None
    return end


@dataclass(frozen=True)
class ResolvedPunch:
    """Which of the six punches a scan actually records, alongside the one
    the employee pressed on the kiosk."""

    event_type: str
    session: str
    requested_event_type: str | None = None
    requested_session: str | None = None
    because: str | None = None
    # Still timed in from the morning and back from lunch without having
    # punched out: record the lunch AM Out automatically, then this PM In.
    auto_lunch_out: bool = False

    @property
    def corrected(self) -> bool:
        return (
            self.requested_event_type is not None
            and (self.event_type, self.session) != (self.requested_event_type, self.requested_session)
        )

    @property
    def label(self) -> str:
        return punch_label(self.event_type, self.session)

    @property
    def requested_label(self) -> str | None:
        if not self.requested_event_type or not self.requested_session:
            return None
        return punch_label(self.requested_event_type, self.requested_session)

    @property
    def note(self) -> str | None:
        if not self.corrected:
            return None
        tail = f" — {self.because}" if self.because else ""
        return f"You selected {self.requested_label}, so this was recorded as {self.label}{tail}."


def resolve_punch(user: User, local: datetime, requested_event_type: str | None = None,
                  requested_session: str | None = None) -> ResolvedPunch:
    """
    Decide which of the six punches a kiosk scan records.

    The button the employee pressed is a *hint*, not an instruction. People
    lose track of which punch they're on, so the selection is overruled
    whenever the record plainly contradicts it: somebody who is still timed
    in can only time out next, and nobody times in again once their shift
    has ended (that is what OT In is for). The AM/PM half is taken from the
    clock against the department's lunch break, never from the button.
    """
    if requested_session == "OT":
        filled = {e.event_type for e in events_in_session(user.id, "OT")}
        if "CLOCK_IN" not in filled:
            because = "your OT time in isn't recorded yet" if requested_event_type == "CLOCK_OUT" else None
            return ResolvedPunch("CLOCK_IN", "OT", requested_event_type, "OT", because)
        because = "you're already timed in for OT" if requested_event_type == "CLOCK_IN" else None
        return ResolvedPunch("CLOCK_OUT", "OT", requested_event_type, "OT", because)

    regular = regular_events_today(user.id)
    last = regular[-1] if regular else None
    end = shift_end_time(user)
    because = None

    break_start, break_end = department_break_times(user)
    if (requested_event_type == "CLOCK_IN" and last is not None and last.event_type == "CLOCK_IN"
            and last.session == "AM" and local >= _at(local, break_end)
            and not (end and local >= _at(local, end))):
        return ResolvedPunch("CLOCK_IN", "PM", requested_event_type, requested_session, auto_lunch_out=True)

    if end and regular and local >= _at(local, end):
        # The shift is over. A regular time in here would be wrong whichever
        # button was pressed — overtime has to be chosen explicitly.
        event_type = "CLOCK_OUT"
        if requested_event_type == "CLOCK_IN":
            because = f"your shift ends at {_pretty(end)} (choose OT In for overtime)"
    elif last is not None and last.event_type == "CLOCK_IN":
        event_type = "CLOCK_OUT"
        if requested_event_type == "CLOCK_IN":
            because = f"you've been timed in since {_local_time(last)}"
    else:
        event_type = "CLOCK_IN"
        if requested_event_type == "CLOCK_OUT":
            because = "you aren't timed in yet" if last is None else f"you timed out at {_local_time(last)}"

    # Which half of the day a punch belongs to is decided by the lunch
    # break, not by noon: leaving at 12:05 is the AM time out, and coming
    # back at 12:55 is the PM time in.
    if event_type == "CLOCK_IN":
        session = "AM" if local < _at(local, break_start) else "PM"
    else:
        session = "AM" if local <= _at(local, break_end) else "PM"

    if because is None and requested_session not in (None, session):
        because = f"it's {local.strftime('%I:%M %p').lstrip('0')}"
    return ResolvedPunch(event_type, session, requested_event_type, requested_session, because)


def late_minutes(event: AttendanceEvent) -> int | None:
    """Minutes late for the AM arrival punch, or None if on time / not applicable."""
    if event.event_type != "CLOCK_IN" or event.session != "AM" or not event.user:
        return None
    cfg = current_app.config
    start, _ = department_schedule(event.user)
    hh, mm = _hhmm(start or cfg["SHIFT_START"])
    local = to_org_tz(event.timestamp)
    cutoff = local.replace(hour=hh, minute=mm, second=0, microsecond=0) + timedelta(minutes=cfg["LATE_GRACE_MINUTES"])
    diff = int((local - cutoff).total_seconds() // 60)
    return diff if diff > 0 else None


def early_minutes(event: AttendanceEvent) -> int | None:
    """Minutes left early for the final PM departure punch, or None if the
    department has no configured end time / the employee left on time or later."""
    if event.event_type != "CLOCK_OUT" or event.session != "PM" or not event.user:
        return None
    _, end = department_schedule(event.user)
    if not end:
        return None
    hh, mm = _hhmm(end)
    local = to_org_tz(event.timestamp)
    cutoff = local.replace(hour=hh, minute=mm, second=0, microsecond=0)
    diff = int((cutoff - local).total_seconds() // 60)
    return diff if diff > 0 else None


def is_late(event: AttendanceEvent) -> bool:
    return late_minutes(event) is not None


def record_attendance(user_id: str, match_score: float, match_status: str,
                      liveness_passed: bool, device_id: str = None,
                      event_type: str | None = None, session: str | None = None,
                      timestamp: datetime | None = None,
                      notes: str | None = None, enforce_cooldown: bool = True) -> AttendanceEvent:
    # PostgreSQL locks this employee row until commit. Concurrent scans for
    # the same employee then re-check the latest event sequentially, avoiding
    # duplicate events that can pass a check-then-insert cooldown race.
    user = User.query.filter_by(id=user_id).with_for_update().first() if enforce_cooldown else db.session.get(User, user_id)
    if not user:
        raise AppError("Employee not found.", 404)
    if not user.is_active:
        raise AppError("This employee is deactivated.", 403)

    now = timestamp or utcnow()
    if now.tzinfo is not None:
        now = now.astimezone(timezone.utc).replace(tzinfo=None)

    if session is not None and session not in SESSIONS:
        raise AppError("Invalid session.", 400)
    if event_type is not None and event_type not in EVENT_TYPES:
        raise AppError("Invalid event type.", 400)

    resolution = None
    # enforce_cooldown doubles as "this is a live kiosk scan, not a
    # deliberate admin correction" — manual entries (enforce_cooldown=False)
    # are always written exactly as asked, and audited separately.
    if enforce_cooldown:
        cfg = current_app.config
        last_event = (
            AttendanceEvent.query.filter_by(user_id=user_id)
            .order_by(AttendanceEvent.timestamp.desc())
            .first()
        )
        if last_event:
            elapsed = (now - last_event.timestamp).total_seconds()
            cooldown = cfg["ATTENDANCE_COOLDOWN_SECONDS"]
            if 0 <= elapsed < cooldown:
                raise CooldownActive(last_event, int(cooldown - elapsed))
            # Re-verification window. Right after a punch people scan again
            # to make sure it took. Every scan inside this window only
            # re-confirms the punch already taken — none of them can start
            # the *next* punch, which is what stops an "am I really in?"
            # re-scan from silently becoming a time out a minute later.
            window = cfg["ATTENDANCE_REVERIFY_WINDOW_SECONDS"]
            if 0 <= elapsed < window:
                raise AlreadyVerified(
                    last_event,
                    reason=(f"Verified — your {punch_label(last_event.event_type, last_event.session)} "
                            f"at {_local_time(last_event)} is recorded. Nothing else to do."),
                    seconds_remaining=int(window - elapsed),
                )

        resolution = resolve_punch(user, to_org_tz(now), event_type, session)
        event_type, session = resolution.event_type, resolution.session

        # Each of the six punches is a once-a-day slot. Past the
        # re-verification window, a scan landing on a slot that is already
        # filled is a mistake, not a new event — reassure, don't write.
        dup = existing_punch(user_id, session, event_type)
        if dup:
            raise AlreadyVerified(
                dup,
                reason=(f"Identity confirmed — your {punch_label(event_type, session)} was already "
                        f"recorded at {_local_time(dup)}."),
            )
    else:
        session = session or current_session(to_org_tz(now))
        event_type = event_type or determine_event_type(user_id, session)

    if resolution is not None and resolution.corrected:
        auto = f"Auto: selected {resolution.requested_label}, recorded as {resolution.label}"
        notes = f"{notes} | {auto}" if notes else auto

    if resolution is not None and resolution.auto_lunch_out:
        # Back from lunch with no AM Out: close the morning at the start of
        # the break so lunch is not counted as worked time.
        break_start, _ = department_break_times(user)
        out_local = _at(to_org_tz(now), break_start)
        db.session.add(AttendanceEvent(
            user_id=user_id,
            event_type="CLOCK_OUT",
            session="AM",
            timestamp=out_local.astimezone(timezone.utc).replace(tzinfo=None),
            match_score=match_score,
            match_status=match_status,
            liveness_passed=liveness_passed,
            device_id=device_id,
            notes="Auto: lunch time out (no AM Out punched)",
        ))

    event = AttendanceEvent(
        user_id=user_id,
        event_type=event_type,
        session=session,
        timestamp=now,
        match_score=match_score,
        match_status=match_status,
        liveness_passed=liveness_passed,
        device_id=device_id,
        notes=notes[:255] if notes else None,
    )
    db.session.add(event)
    db.session.commit()
    # Transient attribute (not a column): lets the kiosk tell the employee
    # their selection was overruled, without re-deriving it from the row.
    event.resolution = resolution
    logger.info(
        "attendance recorded user=%s event_type=%s session=%s requested=%s score=%s status=%s liveness=%s device=%s",
        user_id, event.event_type, session,
        resolution.requested_label if resolution else None,
        round(match_score, 4), match_status, liveness_passed, device_id,
    )
    return event


def event_payload(event: AttendanceEvent) -> dict:
    payload = event.to_dict()
    lm, em = late_minutes(event), early_minutes(event)
    payload["is_late"] = lm is not None
    payload["late_minutes"] = lm
    payload["is_early_leave"] = em is not None
    payload["early_minutes"] = em
    payload["punch_label"] = punch_label(event.event_type, event.session)
    payload["local_time"] = to_org_tz(event.timestamp).strftime("%I:%M %p").lstrip("0")
    payload["timezone"] = str(org_tz())
    resolution = getattr(event, "resolution", None)
    payload["corrected"] = bool(resolution and resolution.corrected)
    payload["correction_note"] = resolution.note if resolution else None
    payload["requested_label"] = resolution.requested_label if resolution else None
    return payload
