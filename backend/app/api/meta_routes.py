"""Organisation settings every signed-in screen needs to display times correctly."""
from flask import Blueprint, current_app, jsonify

from app.utils.auth import require_roles
from app.utils.timezone import now_in_org_tz, org_tz

meta_bp = Blueprint("meta", __name__)


@meta_bp.get("")
@require_roles(allow_kiosk=True)  # the kiosk screen formats times too
def meta():
    """The browser's own clock and timezone can be wrong; the UI formats every
    time and computes every "today" with the organisation's timezone instead."""
    cfg = current_app.config
    now = now_in_org_tz()
    return jsonify({
        "timezone": str(org_tz()),
        "now": now.isoformat(),
        "today": now.date().isoformat(),
        "break_start": cfg["BREAK_START"],
        "break_end": cfg["BREAK_END"],
        "shift_start": cfg["SHIFT_START"],
        "shift_end": cfg["SHIFT_END"],
    })
