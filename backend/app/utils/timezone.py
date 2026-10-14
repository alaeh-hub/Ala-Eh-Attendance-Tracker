from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
from flask import current_app


def org_tz() -> ZoneInfo:
    return ZoneInfo(current_app.config.get("ORG_TIMEZONE", "UTC"))


def utcnow() -> datetime:
    """Naive UTC — the format every timestamp column uses."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def now_in_org_tz() -> datetime:
    return datetime.now(org_tz())


def to_org_tz(naive_utc: datetime) -> datetime:
    return naive_utc.replace(tzinfo=timezone.utc).astimezone(org_tz())


def org_day_bounds_utc(day=None) -> tuple[datetime, datetime]:
    """[start, end) of an org-local calendar day, as naive UTC datetimes."""
    tz = org_tz()
    day = day or now_in_org_tz().date()
    start_local = datetime.combine(day, time.min, tzinfo=tz)
    end_local = start_local + timedelta(days=1)
    to_utc = lambda d: d.astimezone(timezone.utc).replace(tzinfo=None)
    return to_utc(start_local), to_utc(end_local)


def to_naive_utc(aware: datetime) -> datetime:
    """An aware datetime as the naive UTC every timestamp column stores."""
    return aware.astimezone(timezone.utc).replace(tzinfo=None)


def parse_api_timestamp(value) -> datetime:
    """
    Parse a client-supplied timestamp into naive UTC.

    ISO-8601 with an offset or "Z" is taken literally. A naive value
    ("YYYY-MM-DDTHH:mm[:ss]") is org-local wall time: the admin typed the
    time on the org's clock, and the browser's own timezone may differ.
    Raises ValueError for anything unparseable.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError("timestamp must be a string")
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=org_tz())
    return to_naive_utc(parsed)
