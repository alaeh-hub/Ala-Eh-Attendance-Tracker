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
