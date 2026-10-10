"""
The kiosk's guide oval, as the server sees it.

The kiosk draws an oval on screen and sends, with every scan, where that oval
sits in the *camera frame* (normalised 0-1 fractions of the frame, already
corrected for the video being cropped to fill the screen and mirrored).
Only faces inside that area are scanned: a person walking past in the
background is ignored instead of triggering "multiple faces", and someone
standing too far back is asked to move closer.

The zone is deliberately more forgiving than the drawn oval (MARGIN), so a
person standing a little off-centre still scans.
"""
import json
from dataclasses import dataclass

# How much wider than the drawn oval the accepted area is.
MARGIN = 1.3
# The face box must be at least this fraction of the oval's height. A face fitted
# to the oval is roughly 0.55-0.7 of it, so this only rejects people standing back.
MIN_FACE_TO_OVAL = 0.4
# Enrollment is stricter: every stored sample is matched against forever, so a
# small, far-away face makes a poor reference.
ENROLL_MIN_FACE_TO_OVAL = 0.5

MOVE_INTO_CIRCLE = "Move into the circle."
MOVE_CLOSER = "Move closer so your face fills the circle."


@dataclass(frozen=True)
class GuideZone:
    cx: float
    cy: float
    rx: float
    ry: float


def parse_zone(raw) -> GuideZone | None:
    """Parse the kiosk's JSON; anything missing or implausible means 'no zone'
    (the scan then behaves exactly as it did before the oval was enforced)."""
    if not raw:
        return None
    try:
        data = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
        cx, cy, rx, ry = (float(data[k]) for k in ("cx", "cy", "rx", "ry"))
    except (ValueError, TypeError, KeyError):
        return None
    if not all(v == v and abs(v) != float("inf") for v in (cx, cy, rx, ry)):  # rejects NaN / inf
        return None
    if not (0.0 <= cx <= 1.0 and 0.0 <= cy <= 1.0 and 0.03 <= rx <= 0.8 and 0.03 <= ry <= 0.8):
        return None
    return GuideZone(cx, cy, rx, ry)


def inside_zone(zone: GuideZone, box, image_w: int, image_h: int) -> bool:
    """True when the centre of the face box lies inside the (widened) oval."""
    top, right, bottom, left = box
    fx = (left + right) / 2.0 / image_w
    fy = (top + bottom) / 2.0 / image_h
    return ((fx - zone.cx) / (zone.rx * MARGIN)) ** 2 + ((fy - zone.cy) / (zone.ry * MARGIN)) ** 2 <= 1.0


def faces_in_zone(zone: GuideZone, faces, image_w: int, image_h: int) -> list:
    return [f for f in faces if inside_zone(zone, f.box, image_w, image_h)]


def too_small(zone: GuideZone, box, image_h: int, ratio: float = MIN_FACE_TO_OVAL) -> bool:
    top, _, bottom, _ = box
    return (bottom - top) / float(image_h) < ratio * (2.0 * zone.ry)
