import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

from flask import current_app
from sqlalchemy import func, or_

from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.attendance_event import AttendanceEvent
from app.models.department import Department
from app.models.user import User
from app.utils.timezone import org_day_bounds_utc, org_tz, to_naive_utc, to_org_tz, utcnow

logger = logging.getLogger("app.attendance")

EVENT_TYPES = ("CLOCK_IN", "CLOCK_OUT")
# The kiosk offers six punches — the classic 4-punch DTR plus an overtime
# pair. AM and PM are both regular-shift sessions and share a single
# in/out sequence for the day; OT runs its own sequence and is only ever
# entered explicitly. "AM"/"PM" mean first/second half of the WORK DAY
# (before/after the break), not literal morning/afternoon: on a 22:00-06:00
# night shift the "AM" half is 22:00-02:00.
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

# How far before a shift's start its work day begins, for schedules whose
# work day cannot simply start at midnight (overnight shifts, or very early
# starts). A 22:00 start with a 6h buffer owns 16:00 -> 16:00 next day.
DEFAULT_ROLLOVER_BUFFER_HOURS = 6
# A clock-in is matched to the rotating shift whose start is nearest, but
# only within this many hours of it; otherwise no shift (and no lateness).
DEFAULT_SHIFT_MATCH_WINDOW_HOURS = 4

# How far back to look for the employee's current work day. Longer than any
# work day window (24h) plus slack for long shifts.
_HISTORY_LOOKBACK = timedelta(hours=36)


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


def _minutes(value: str) -> int:
    hh, mm = _hhmm(value)
    return hh * 60 + mm


def _span_minutes(start: str, end: str) -> int:
    """Length of start->end in minutes, wrapping past midnight. end == start
    is read as a full 24 hours rather than zero."""
    return (_minutes(end) - _minutes(start)) % 1440 or 1440


def is_overnight(start: str | None, end: str | None) -> bool:
    """A schedule ends on the next calendar day when its end is not after its start."""
    return bool(start and end) and _minutes(end) <= _minutes(start)


def _pretty(hhmm: str) -> str:
    hh, mm = _hhmm(hhmm)
    return datetime(2000, 1, 1, hh, mm).strftime("%I:%M %p").lstrip("0")


def _local_time(event: AttendanceEvent) -> str:
    return to_org_tz(event.timestamp).strftime("%I:%M %p").lstrip("0")


def current_session(local_dt: datetime) -> str:
    """AM = 12am-12pm, PM = 12pm-12am, org-local time. Only a last-resort
    fallback; real punches are split by the work day's break (WorkDay.session_for)."""
    return "AM" if local_dt.hour < 12 else "PM"


def _cfg_number(name: str, default: int) -> float:
    try:
        return float(current_app.config.get(name, default))
    except (TypeError, ValueError):
        return float(default)


def rollover_minutes(start: str | None, end: str | None) -> int:
    """
    Where a work day begins, in minutes from midnight of its work_date
    (negative = on the previous calendar day).

    Day schedules keep the calendar day (0 = midnight), so every day-shift
    rule behaves exactly as it always has. A schedule that crosses midnight
    — or starts so early that its early-arrival buffer would — begins its
    work day `WORKDAY_ROLLOVER_BUFFER_HOURS` before the shift starts, so
    the whole shift (and an early arrival) lands in one work day.
    """
    if not start:
        return 0
    buffer = int(_cfg_number("WORKDAY_ROLLOVER_BUFFER_HOURS", DEFAULT_ROLLOVER_BUFFER_HOURS) * 60)
    s = _minutes(start)
    if is_overnight(start, end) or s < buffer:
        return s - buffer
    return 0


@dataclass(frozen=True)
class WorkDay:
    """
    One employee's work day: a 24-hour window labelled with the date its
    shift starts, plus the schedule that applies inside it.

    Every clock reading (shift start/end, break) is anchored INSIDE the
    window, which is what makes night shifts work: for a 22:00-06:00 shift
    with a 02:00 break and work_date D, the window is D 16:00 -> D+1 16:00,
    the end is D+1 06:00 and the break D+1 02:00-03:00.
    """

    work_date: date
    rollover: int
    scheduled_start: str | None
    scheduled_end: str | None
    break_start: str | None
    break_end: str | None
    shift_name: str | None = None

    @classmethod
    def build(cls, work_date: date, start: str | None, end: str | None,
              break_start: str | None, break_end: str | None, shift_name: str | None = None) -> "WorkDay":
        return cls(work_date, rollover_minutes(start, end), start, end, break_start, break_end, shift_name)

    @classmethod
    def for_moment(cls, local: datetime, start: str | None, end: str | None,
                   break_start: str | None, break_end: str | None, shift_name: str | None = None) -> "WorkDay":
        """The work day of this schedule that contains `local`."""
        roll = rollover_minutes(start, end)
        work_date = (local.replace(tzinfo=None) - timedelta(minutes=roll)).date()
        return cls(work_date, roll, start, end, break_start, break_end, shift_name)

    # -- window -----------------------------------------------------------
    @property
    def _midnight(self) -> datetime:
        return datetime.combine(self.work_date, time.min, tzinfo=org_tz())

    @property
    def window_start(self) -> datetime:
        return self._midnight + timedelta(minutes=self.rollover)

    @property
    def window_end(self) -> datetime:
        return self.window_start + timedelta(days=1)

    def bounds_utc(self) -> tuple[datetime, datetime]:
        return to_naive_utc(self.window_start), to_naive_utc(self.window_end)

    def contains(self, local: datetime) -> bool:
        return self.window_start <= local < self.window_end

    def at(self, hhmm: str) -> datetime:
        """"HH:MM" as the org-local datetime it falls on inside this work day."""
        offset = (_minutes(hhmm) - self.rollover) % 1440 + self.rollover
        return self._midnight + timedelta(minutes=offset)

    # -- schedule ---------------------------------------------------------
    @property
    def start_dt(self) -> datetime | None:
        return self.at(self.scheduled_start) if self.scheduled_start else None

    @property
    def end_dt(self) -> datetime | None:
        if not self.scheduled_end:
            return None
        if self.scheduled_start:
            return self.start_dt + timedelta(minutes=_span_minutes(self.scheduled_start, self.scheduled_end))
        return self.at(self.scheduled_end)

    @property
    def break_window(self) -> tuple[datetime, datetime] | None:
        """The unpaid break inside this work day, or None. A break that lies
        outside the shift (e.g. a rotating department's 12:00 lunch on its
        night shift) does not apply to that shift at all."""
        if not self.break_start or not self.break_end:
            return None
        b_start = self.at(self.break_start)
        b_end = b_start + timedelta(minutes=_span_minutes(self.break_start, self.break_end))
        s, e = self.start_dt, self.end_dt
        if s is not None and e is not None and not (s <= b_start and b_end <= e):
            return None
        return b_start, b_end

    def session_for(self, event_type: str, local: datetime) -> str:
        """Which half of the work day a regular punch belongs to. Decided by
        the break, not by noon: leaving at 12:05 is the AM time out, and
        coming back at 12:55 is the PM time in. Without an applicable break
        the shift's midpoint splits the halves."""
        window = self.break_window
        if window is None:
            s, e = self.start_dt, self.end_dt
            if s is not None and e is not None:
                mid = s + (e - s) / 2
                window = (mid, mid)
            else:
                noon = self.at("12:00")
                window = (noon, noon)
        b_start, b_end = window
        if event_type == "CLOCK_IN":
            return "AM" if local < b_start else "PM"
        return "AM" if local <= b_end else "PM"

    def late_minutes_at(self, local: datetime) -> int | None:
        """Minutes past start + grace (0 = on time), or None with no start."""
        start = self.start_dt
        if start is None:
            return None
        cutoff = start + timedelta(minutes=_cfg_number("LATE_GRACE_MINUTES", 15))
        return max(0, int((local - cutoff).total_seconds() // 60))

    def early_minutes_at(self, local: datetime) -> int | None:
        """Minutes before the scheduled end (0 = on time), or None with no end."""
        end = self.end_dt
        if end is None:
            return None
        return max(0, int((end - local).total_seconds() // 60))


# --- schedules ---------------------------------------------------------------

def _find_department(user: User) -> Department | None:
    if not user.department:
        return None
    return Department.query.filter(func.lower(Department.name) == user.department.lower()).first()


def department_break_times(user: User, dept: Department | None = None) -> tuple[str, str]:
    """(break_start, break_end) as "HH:MM" strings — the employee's
    department's configured break window, falling back to the global
    config default when the department has none configured."""
    cfg = current_app.config
    dept = dept if dept is not None else _find_department(user)
    start = (dept.break_start if dept else None) or cfg["BREAK_START"]
    end = (dept.break_end if dept else None) or cfg["BREAK_END"]
    return start, end


def match_shift(shifts: list, local: datetime) -> tuple[dict, datetime] | None:
    """
    The rotating shift this clock reading belongs to: the one whose start
    (on the previous, same or next calendar day — so 23:50 matches a 00:00
    shift) is nearest, provided it is within SHIFT_MATCH_WINDOW_HOURS.
    Returns (shift, org-local start datetime) or None.
    """
    window = timedelta(hours=_cfg_number("SHIFT_MATCH_WINDOW_HOURS", DEFAULT_SHIFT_MATCH_WINDOW_HOURS))
    best = None
    for shift in shifts or []:
        try:
            hh, mm = _hhmm(shift["start_time"])
        except (KeyError, TypeError, ValueError):
            continue
        for days in (-1, 0, 1):
            candidate = datetime.combine(local.date() + timedelta(days=days), time(hh, mm), tzinfo=local.tzinfo)
            distance = abs(local - candidate)
            if distance <= window and (best is None or distance < best[0]):
                best = (distance, shift, candidate)
    return (best[1], best[2]) if best else None


def _fresh_work_day(dept: Department | None, local: datetime, break_times: tuple[str, str]) -> WorkDay:
    """The work day `local` falls in, judged only from the CURRENT schedule."""
    cfg = current_app.config
    if dept is not None and dept.has_shifting:
        matched = match_shift(dept.shifts, local)
        if matched is None:
            # No shift starts anywhere near now: nothing to be late for and
            # no known end. The calendar day is the work day.
            return WorkDay.build(local.date(), None, None, *break_times)
        shift, start_local = matched
        wd = WorkDay.build(start_local.date(), shift["start_time"], shift.get("end_time"), *break_times,
                           shift_name=shift.get("name"))
        if wd.contains(local):
            return wd
        return WorkDay.for_moment(local, shift["start_time"], shift.get("end_time"), *break_times,
                                  shift_name=shift.get("name"))
    start = (dept.start_time if dept else None) or cfg.get("SHIFT_START") or None
    end = (dept.end_time if dept else None) or cfg.get("SHIFT_END") or None
    return WorkDay.for_moment(local, start, end, *break_times)


def _in_work_day(query, work_day: WorkDay):
    """Restrict an AttendanceEvent query to one work day: inside its window
    and not stamped with a different work date (windows of consecutive
    work days can overlap after a schedule change)."""
    start, end = work_day.bounds_utc()
    return query.filter(
        AttendanceEvent.timestamp >= start,
        AttendanceEvent.timestamp < end,
        or_(AttendanceEvent.work_date.is_(None), AttendanceEvent.work_date == work_day.work_date),
    )


def resolve_work_day(user: User, local: datetime, *, history: bool = True,
                     exclude_event_id: str | None = None, dept=...) -> WorkDay:
    """
    The work day (and schedule) a punch by `user` at org-local `local`
    belongs to.

    The current schedule proposes one, but the employee's latest stamped
    punch wins while `local` is still inside that punch's work day: a night
    worker's 06:05 time out must land in the work day their 22:00 time in
    opened, even though no rotating shift starts near 06:05, and an admin
    editing the department mid-shift must not split a shift in two. Only
    once that chain is closed (last regular punch is a time out) can a
    different shift start a new work day.
    """
    if dept is ...:
        dept = _find_department(user)
    break_times = department_break_times(user, dept)
    fresh = _fresh_work_day(dept, local, break_times)
    if not history or user.id is None:
        return fresh

    local_utc = to_naive_utc(local)
    q = AttendanceEvent.query.filter(
        AttendanceEvent.user_id == user.id,
        AttendanceEvent.work_date.isnot(None),
        AttendanceEvent.timestamp <= local_utc,
        AttendanceEvent.timestamp >= local_utc - _HISTORY_LOOKBACK,
    )
    if exclude_event_id:
        q = q.filter(AttendanceEvent.id != exclude_event_id)
    recent = q.order_by(AttendanceEvent.timestamp.desc()).first()
    if recent is None:
        return fresh
    stored = WorkDay.build(recent.work_date, recent.scheduled_start, recent.scheduled_end, *break_times)
    if not stored.contains(local):
        return fresh
    if fresh.scheduled_start in (None, stored.scheduled_start) and fresh.scheduled_end in (None, stored.scheduled_end):
        return stored
    chain = _in_work_day(AttendanceEvent.query.filter(
        AttendanceEvent.user_id == user.id,
        AttendanceEvent.session.in_(REGULAR_SESSIONS),
        AttendanceEvent.timestamp <= local_utc,
    ), stored)
    if exclude_event_id:
        chain = chain.filter(AttendanceEvent.id != exclude_event_id)
    last = chain.order_by(AttendanceEvent.timestamp.desc()).first()
    if last is not None and last.event_type == "CLOCK_IN":
        return stored
    return fresh


def event_work_day(event: AttendanceEvent, dept=...) -> WorkDay:
    """The work day an existing event belongs to: from its stamped schedule
    when it has one, else re-derived from the current schedule (legacy rows)."""
    user = event.user
    if dept is ...:
        dept = _find_department(user) if user else None
    break_times = department_break_times(user, dept) if user else (
        current_app.config["BREAK_START"], current_app.config["BREAK_END"])
    if event.work_date is not None:
        return WorkDay.build(event.work_date, event.scheduled_start, event.scheduled_end, *break_times)
    return _fresh_work_day(dept, to_org_tz(event.timestamp), break_times)


def schedule_work_day(user: User, local: datetime, dept=...) -> WorkDay:
    """The work day `local` falls in by the CURRENT schedule alone (no punch
    history). Reports use it, with a pre-fetched `dept`, to avoid a query
    per employee."""
    if dept is ...:
        dept = _find_department(user)
    return _fresh_work_day(dept, local, department_break_times(user, dept))


def departments_by_name() -> dict:
    """{lower-cased name: Department} — one query, for per-employee lookups in reports."""
    return {d.name.lower(): d for d in Department.query.all()}


def user_department(user: User | None, by_name: dict) -> Department | None:
    if user is None or not user.department:
        return None
    return by_name.get(user.department.lower())


def refresh_arrival_lateness(user_id: str, work_date: date | None) -> None:
    """
    Keep "late" on the work day's FIRST regular time in after a correction
    or deletion reshuffles the day: the event that is now first gets its
    lateness stamped (against its own frozen schedule) if it had none, and
    any later time in loses a stale late flag. Legacy (unstamped) rows are
    judged at read time and left alone.
    """
    if work_date is None:
        return
    ins = (
        AttendanceEvent.query.filter(
            AttendanceEvent.user_id == user_id,
            AttendanceEvent.work_date == work_date,
            AttendanceEvent.session.in_(REGULAR_SESSIONS),
            AttendanceEvent.event_type == "CLOCK_IN",
        )
        .order_by(AttendanceEvent.timestamp.asc())
        .all()
    )
    for i, e in enumerate(ins):
        if i == 0:
            if e.late_minutes is None:
                e.late_minutes = event_work_day(e).late_minutes_at(to_org_tz(e.timestamp))
        else:
            e.late_minutes = None


def _current_work_day(user_id: str, now: datetime | None = None) -> WorkDay | None:
    user = db.session.get(User, user_id)
    if user is None:
        return None
    local = to_org_tz(now) if now is not None else to_org_tz(utcnow())
    return resolve_work_day(user, local)


# --- the day's punches --------------------------------------------------------

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


def events_in_session(user_id: str, session: str, work_day: WorkDay | None = None) -> list[AttendanceEvent]:
    """This work day's events of one session (default: the current work day)."""
    work_day = work_day or _current_work_day(user_id)
    if work_day is None:
        return []
    return (
        _in_work_day(AttendanceEvent.query.filter(
            AttendanceEvent.user_id == user_id,
            AttendanceEvent.session == session,
        ), work_day)
        .order_by(AttendanceEvent.timestamp.asc())
        .all()
    )


def regular_events_in(user_id: str, work_day: WorkDay) -> list[AttendanceEvent]:
    """A work day's AM and PM events as one ascending sequence.

    The regular shift is a single in/out chain across the whole work day,
    not one chain per half. Somebody who times in at 8am and never punches
    for lunch is *still timed in* at 5pm, so their next punch is a time out
    — whichever half of the day it lands in.
    """
    return (
        _in_work_day(AttendanceEvent.query.filter(
            AttendanceEvent.user_id == user_id,
            AttendanceEvent.session.in_(REGULAR_SESSIONS),
        ), work_day)
        .order_by(AttendanceEvent.timestamp.asc())
        .all()
    )


def regular_events_today(user_id: str) -> list[AttendanceEvent]:
    """The current work day's regular chain (see regular_events_in)."""
    work_day = _current_work_day(user_id)
    return regular_events_in(user_id, work_day) if work_day else []


def determine_event_type(user_id: str, session: str, work_day: WorkDay | None = None) -> str:
    """Alternates CLOCK_IN / CLOCK_OUT along the work day's relevant chain —
    the shared AM+PM regular chain, or the separate OT chain. The first
    scan of each chain is always a CLOCK_IN."""
    work_day = work_day or _current_work_day(user_id)
    if work_day is None:
        return "CLOCK_IN"
    events = events_in_session(user_id, "OT", work_day) if session == "OT" else regular_events_in(user_id, work_day)
    if not events or events[-1].event_type == "CLOCK_OUT":
        return "CLOCK_IN"
    return "CLOCK_OUT"


def existing_punch(user_id: str, session: str, event_type: str,
                   work_day: WorkDay | None = None) -> AttendanceEvent | None:
    """The event of this exact type already recorded for this session of the work day, if any."""
    return next((e for e in events_in_session(user_id, session, work_day) if e.event_type == event_type), None)


def punch_label(event_type: str, session: str) -> str:
    return PUNCH_LABELS.get((event_type, session), f"{session} {event_type.replace('CLOCK_', '').title()}")


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
                  requested_session: str | None = None, work_day: WorkDay | None = None) -> ResolvedPunch:
    """
    Decide which of the six punches a kiosk scan records.

    The button the employee pressed is a *hint*, not an instruction. People
    lose track of which punch they're on, so the selection is overruled
    whenever the record plainly contradicts it: somebody who is still timed
    in can only time out next, and nobody times in again once their shift
    has ended (that is what OT In is for). The AM/PM half is taken from the
    clock against the work day's break, never from the button.

    Every comparison uses datetimes anchored in the employee's work day, so
    a 22:00-06:00 shift with a 02:00 break behaves exactly like a day shift.
    """
    work_day = work_day or resolve_work_day(user, local)
    if requested_session == "OT":
        filled = {e.event_type for e in events_in_session(user.id, "OT", work_day)}
        if "CLOCK_IN" not in filled:
            because = "your OT time in isn't recorded yet" if requested_event_type == "CLOCK_OUT" else None
            return ResolvedPunch("CLOCK_IN", "OT", requested_event_type, "OT", because)
        because = "you're already timed in for OT" if requested_event_type == "CLOCK_IN" else None
        return ResolvedPunch("CLOCK_OUT", "OT", requested_event_type, "OT", because)

    regular = regular_events_in(user.id, work_day)
    last = regular[-1] if regular else None
    end = work_day.end_dt
    break_window = work_day.break_window
    because = None

    if (requested_event_type == "CLOCK_IN" and last is not None and last.event_type == "CLOCK_IN"
            and last.session == "AM" and break_window is not None and local >= break_window[1]
            and not (end and local >= end)):
        return ResolvedPunch("CLOCK_IN", "PM", requested_event_type, requested_session, auto_lunch_out=True)

    if end and regular and local >= end:
        # The shift is over. A regular time in here would be wrong whichever
        # button was pressed — overtime has to be chosen explicitly.
        event_type = "CLOCK_OUT"
        if requested_event_type == "CLOCK_IN":
            because = f"your shift ends at {_pretty(work_day.scheduled_end)} (choose OT In for overtime)"
    elif last is not None and last.event_type == "CLOCK_IN":
        event_type = "CLOCK_OUT"
        if requested_event_type == "CLOCK_IN":
            because = f"you've been timed in since {_local_time(last)}"
    else:
        event_type = "CLOCK_IN"
        if requested_event_type == "CLOCK_OUT":
            because = "you aren't timed in yet" if last is None else f"you timed out at {_local_time(last)}"

    session = work_day.session_for(event_type, local)

    if because is None and requested_session not in (None, session):
        because = f"it's {local.strftime('%I:%M %p').lstrip('0')}"
    return ResolvedPunch(event_type, session, requested_event_type, requested_session, because)


# --- lateness ----------------------------------------------------------------

def stamp_schedule(event: AttendanceEvent, work_day: WorkDay) -> None:
    """
    Freeze the schedule facts onto the event: its work day, the schedule
    that applied, and how late / early it was against that schedule.
    Done at write time (and again on an admin correction) so that editing
    a department later never rewrites past attendance.

    Lateness is measured on the work day's FIRST regular time in, whichever
    half it lands in (arriving at 14:00 for an 08:00 shift is late, even
    though it is a PM time in); early leave on a regular PM time out.
    0 means "checked and on time"; NULL means "not applicable".
    """
    event.work_date = work_day.work_date
    event.scheduled_start = work_day.scheduled_start
    event.scheduled_end = work_day.scheduled_end
    event.late_minutes = None
    event.early_minutes = None
    if event.session not in REGULAR_SESSIONS:
        return
    local = to_org_tz(event.timestamp)
    if event.event_type == "CLOCK_IN" and work_day.start_dt is not None:
        with db.session.no_autoflush:
            earlier = _in_work_day(AttendanceEvent.query.filter(
                AttendanceEvent.user_id == event.user_id,
                AttendanceEvent.session.in_(REGULAR_SESSIONS),
                AttendanceEvent.event_type == "CLOCK_IN",
                AttendanceEvent.timestamp < event.timestamp,
            ), work_day)
            if event.id is not None:
                earlier = earlier.filter(AttendanceEvent.id != event.id)
            is_first = earlier.first() is None
        if is_first:
            event.late_minutes = work_day.late_minutes_at(local)
    elif event.event_type == "CLOCK_OUT" and event.session == "PM":
        event.early_minutes = work_day.early_minutes_at(local)


def late_minutes(event: AttendanceEvent) -> int | None:
    """Minutes late for the work day's arrival punch, or None if on time /
    not applicable. Stored value when the event has one; legacy rows (no
    stamp) are judged against the current schedule like they always were."""
    if event.work_date is not None:
        return event.late_minutes or None
    if event.event_type != "CLOCK_IN" or event.session != "AM" or not event.user:
        return None
    return event_work_day(event).late_minutes_at(to_org_tz(event.timestamp)) or None


def early_minutes(event: AttendanceEvent) -> int | None:
    """Minutes left early for the final PM departure punch, or None if not
    applicable / the employee left on time or later. Stored when available."""
    if event.work_date is not None:
        return event.early_minutes or None
    if event.event_type != "CLOCK_OUT" or event.session != "PM" or not event.user:
        return None
    return event_work_day(event).early_minutes_at(to_org_tz(event.timestamp)) or None


def is_late(event: AttendanceEvent) -> bool:
    return late_minutes(event) is not None


# --- writing -----------------------------------------------------------------

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

    local = to_org_tz(now)
    work_day = resolve_work_day(user, local)

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

        resolution = resolve_punch(user, local, event_type, session, work_day=work_day)
        event_type, session = resolution.event_type, resolution.session

        # Each of the six punches is a once-a-work-day slot. Past the
        # re-verification window, a scan landing on a slot that is already
        # filled is a mistake, not a new event — reassure, don't write.
        dup = existing_punch(user_id, session, event_type, work_day)
        if dup:
            raise AlreadyVerified(
                dup,
                reason=(f"Identity confirmed — your {punch_label(event_type, session)} was already "
                        f"recorded at {_local_time(dup)}."),
            )
    else:
        if event_type is None:
            event_type = determine_event_type(user_id, session or "AM", work_day)
        # Default half from the work day's break (not noon), so a manual
        # 12:30 time out on an 08:00-17:00 day is the AM (lunch) time out
        # and a 23:00 time in on a night shift is that shift's AM.
        session = session or work_day.session_for(event_type, local)

    if resolution is not None and resolution.corrected:
        auto = f"Auto: selected {resolution.requested_label}, recorded as {resolution.label}"
        notes = f"{notes} | {auto}" if notes else auto

    if resolution is not None and resolution.auto_lunch_out:
        # Back from the break with no AM Out: close the first half at the
        # start of the break so the break is not counted as worked time.
        lunch_out = AttendanceEvent(
            user_id=user_id,
            event_type="CLOCK_OUT",
            session="AM",
            timestamp=to_naive_utc(work_day.break_window[0]),
            match_score=match_score,
            match_status=match_status,
            liveness_passed=liveness_passed,
            device_id=device_id,
            notes="Auto: lunch time out (no AM Out punched)",
        )
        stamp_schedule(lunch_out, work_day)
        db.session.add(lunch_out)

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
    stamp_schedule(event, work_day)
    db.session.add(event)
    db.session.commit()
    # Transient attribute (not a column): lets the kiosk tell the employee
    # their selection was overruled, without re-deriving it from the row.
    event.resolution = resolution
    logger.info(
        "attendance recorded user=%s event_type=%s session=%s work_date=%s requested=%s score=%s status=%s liveness=%s device=%s",
        user_id, event.event_type, session, event.work_date,
        resolution.requested_label if resolution else None,
        round(match_score, 4), match_status, liveness_passed, device_id,
    )
    return event


def restamp_event(event: AttendanceEvent) -> None:
    """Recompute an existing event's work day and lateness from the current
    schedule — used when an admin corrects it (type, session or time)."""
    user = event.user or db.session.get(User, event.user_id)
    work_day = resolve_work_day(user, to_org_tz(event.timestamp), exclude_event_id=event.id)
    stamp_schedule(event, work_day)


def event_work_date(event: AttendanceEvent, dept=...) -> date:
    """The event's work date: stamped, or derived for legacy rows."""
    if event.work_date is not None:
        return event.work_date
    if event.user is None:
        return to_org_tz(event.timestamp).date()
    return event_work_day(event, dept).work_date


def event_payload(event: AttendanceEvent) -> dict:
    payload = event.to_dict()
    lm, em = late_minutes(event), early_minutes(event)
    payload["is_late"] = lm is not None
    payload["late_minutes"] = lm
    payload["is_early_leave"] = em is not None
    payload["early_minutes"] = em
    if event.work_date is None:
        # Legacy row: derive the work day from the current schedule.
        wd = event_work_day(event) if event.user else None
        payload["work_date"] = wd.work_date.isoformat() if wd else to_org_tz(event.timestamp).date().isoformat()
        payload["scheduled_start"] = wd.scheduled_start if wd else None
        payload["scheduled_end"] = wd.scheduled_end if wd else None
    payload["punch_label"] = punch_label(event.event_type, event.session)
    payload["local_time"] = to_org_tz(event.timestamp).strftime("%I:%M %p").lstrip("0")
    payload["timezone"] = str(org_tz())
    resolution = getattr(event, "resolution", None)
    payload["corrected"] = bool(resolution and resolution.corrected)
    payload["correction_note"] = resolution.note if resolution else None
    payload["requested_label"] = resolution.requested_label if resolution else None
    return payload
