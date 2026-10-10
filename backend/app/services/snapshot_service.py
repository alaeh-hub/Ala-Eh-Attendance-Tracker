"""
Check-in snapshots: an audit trail for matched punches and a review queue
for everything the kiosk could not confidently resolve.
"""
import logging
import threading
import time
from datetime import datetime, timedelta

from flask import current_app

from app.extensions import db
from app.models.scan_snapshot import ScanSnapshot
from app.utils.crypto import encrypt_bytes

logger = logging.getLogger("app.snapshots")

# Statuses that need a human look. LIVENESS_FAILED is kept for audit but is
# not "pending": the person was identified, they just hadn't blinked yet.
PENDING_STATUSES = ("NO_MATCH", "LOW_CONFIDENCE", "AMBIGUOUS_MATCH", "SPOOF_SUSPECTED")

_throttle: dict = {}
_throttle_lock = threading.Lock()
_last_purge = 0.0


def _throttled(device_id: str, status: str, seconds: int) -> bool:
    now = time.monotonic()
    key = (device_id, status)
    with _throttle_lock:
        if now - _throttle.get(key, -1e9) < seconds:
            return True
        _throttle[key] = now
        if len(_throttle) > 500:
            for k in [k for k, t in _throttle.items() if now - t > 3600]:
                del _throttle[k]
    return False


def save_snapshot(jpeg, status, *, device_id=None, user_id=None, candidate_user_id=None, event_id=None,
                  score=None, runner_up_score=None, spoof_score=None):
    """Best-effort: a failure here is logged and swallowed, never allowed to break a check-in."""
    cfg = current_app.config
    if not cfg["SNAPSHOTS_ENABLED"] or not jpeg:
        return None
    if status != "MATCHED" and _throttled(device_id or "kiosk", status, cfg["SNAPSHOT_THROTTLE_SECONDS"]):
        return None
    try:
        snap = ScanSnapshot(
            user_id=user_id, candidate_user_id=candidate_user_id, event_id=event_id, status=status,
            score=score, runner_up_score=runner_up_score, spoof_score=spoof_score, device_id=device_id,
            image=encrypt_bytes(jpeg),
        )
        db.session.add(snap)
        db.session.commit()
        purge_old()
        return snap
    except Exception:  # noqa: BLE001
        db.session.rollback()
        logger.exception("could not save scan snapshot status=%s", status)
        return None


def purge_old(force: bool = False) -> int:
    """Delete snapshots past retention (checked at most once an hour)."""
    global _last_purge
    now = time.monotonic()
    if not force and now - _last_purge < 3600:
        return 0
    _last_purge = now
    cfg = current_app.config
    cutoff_matched = datetime.utcnow() - timedelta(days=cfg["SNAPSHOT_RETENTION_DAYS"])
    cutoff_other = datetime.utcnow() - timedelta(days=cfg["SNAPSHOT_UNMATCHED_RETENTION_DAYS"])
    try:
        deleted = ScanSnapshot.query.filter(
            ((ScanSnapshot.status == "MATCHED") & (ScanSnapshot.created_at < cutoff_matched))
            | ((ScanSnapshot.status != "MATCHED") & (ScanSnapshot.created_at < cutoff_other))
        ).delete(synchronize_session=False)
        db.session.commit()
        return deleted
    except Exception:  # noqa: BLE001
        db.session.rollback()
        logger.exception("snapshot purge failed")
        return 0
