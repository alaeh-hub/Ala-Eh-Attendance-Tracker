"""Face-box continuity across a burst of frames."""

# Two consecutive face boxes belong to the same physical face only if they
# overlap this much and are about the same size. Burst frames are ~120ms
# apart: a person moving naturally keeps IoU well above 0.5, whereas a photo
# or phone swapped in for another face jumps or changes scale.
TRACK_MIN_IOU = 0.3
TRACK_MAX_SIZE_RATIO = 1.4


def box_iou(a, b) -> float:
    """Intersection over union of two (top, right, bottom, left) boxes."""
    at, ar, ab, al = a
    bt, br, bb, bl = b
    iw = max(0, min(ar, br) - max(al, bl))
    ih = max(0, min(ab, bb) - max(at, bt))
    inter = iw * ih
    union = max(0, ar - al) * max(0, ab - at) + max(0, br - bl) * max(0, bb - bt) - inter
    return inter / union if union > 0 else 0.0


def same_track(previous_box, box, min_iou: float) -> bool:
    """Is `box` the same physical face as `previous_box` (None = a broken track)?"""
    if previous_box is None:
        return False
    ph, h = max(previous_box[2] - previous_box[0], 1), max(box[2] - box[0], 1)
    pw, w = max(previous_box[1] - previous_box[3], 1), max(box[1] - box[3], 1)
    if max(ph / h, h / ph, pw / w, w / pw) > TRACK_MAX_SIZE_RATIO:
        return False
    return box_iou(previous_box, box) >= min_iou
