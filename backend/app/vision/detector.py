"""
Face detection. Uses dlib's HOG detector on a DOWNSCALED copy of the
frame, then maps the box back to full resolution. HOG cost grows with
pixel count, so detecting at ~480px wide instead of 1280px is 5-7x
faster, while landmarks and embeddings are still computed on the
full-resolution image so accuracy is not lost.

Boxes are (top, right, bottom, left) in full-image coordinates, the
same shape face_recognition uses, so the rest of the app is unchanged.
"""
import cv2
import dlib
import numpy as np
from face_recognition.api import face_detector

DEFAULT_DETECTION_WIDTH = 480
# In a kiosk queue, people behind the user may be visible. A face that is
# at least this many times larger than every other face is treated as
# "the person at the kiosk" instead of rejecting the frame outright.
DOMINANT_FACE_AREA_RATIO = 1.8


def _to_box(rect: dlib.rectangle, scale: float, shape) -> tuple:
    h, w = shape[:2]
    top = max(int(rect.top() / scale), 0)
    right = min(int(rect.right() / scale), w)
    bottom = min(int(rect.bottom() / scale), h)
    left = max(int(rect.left() / scale), 0)
    return (top, right, bottom, left)


def box_area(box) -> int:
    top, right, bottom, left = box
    return max(0, bottom - top) * max(0, right - left)


def detect_faces(image_rgb: np.ndarray, detection_width: int = DEFAULT_DETECTION_WIDTH):
    """Returns a list of (box, detector_score), largest face first."""
    h, w = image_rgb.shape[:2]
    scale = 1.0
    small = image_rgb
    if w > detection_width:
        scale = detection_width / float(w)
        small = cv2.resize(image_rgb, (detection_width, int(h * scale)), interpolation=cv2.INTER_AREA)

    # Upsample once only when the downscaled image is small; faces at a
    # kiosk are large, so 0 upsamples is enough at 480px and much faster.
    upsample = 1 if small.shape[1] < 400 else 0
    rects, scores, _ = face_detector.run(small, upsample, 0.0)
    faces = [(_to_box(r, scale, image_rgb.shape), float(s)) for r, s in zip(rects, scores)]
    faces.sort(key=lambda f: box_area(f[0]), reverse=True)
    return faces


def detect_single_face(image_rgb: np.ndarray, detection_width: int = DEFAULT_DETECTION_WIDTH,
                       allow_dominant: bool = False):
    """
    Returns (box, error). With allow_dominant, a clearly-closest face is
    accepted even if smaller faces are in the background (kiosk use).
    Enrollment keeps the strict "exactly one face" rule.
    """
    faces = detect_faces(image_rgb, detection_width)
    if not faces:
        return None, "No face detected. Move into frame and try again."
    if len(faces) > 1:
        dominant = box_area(faces[0][0]) >= DOMINANT_FACE_AREA_RATIO * box_area(faces[1][0])
        if not (allow_dominant and dominant):
            return None, "Multiple faces detected. Only one person should be visible."
    return faces[0][0], None


def detect_in_region(image_rgb: np.ndarray, previous_box, detection_width: int = DEFAULT_DETECTION_WIDTH):
    """
    Tracks a face between consecutive burst frames: searches only a crop
    around where the face was in the previous frame (the person barely
    moves in ~100ms). The crop is ~1/6 of the frame, so this is several
    times faster than a full-frame search. Returns a box or None.
    """
    top, right, bottom, left = previous_box
    h, w = image_rgb.shape[:2]
    size = max(bottom - top, right - left)
    pad = int(size * 0.6)
    y0, y1 = max(top - pad, 0), min(bottom + pad, h)
    x0, x1 = max(left - pad, 0), min(right + pad, w)
    crop = image_rgb[y0:y1, x0:x1]
    if crop.size == 0:
        return None
    # Scale so the face is ~120px: comfortably above HOG's 80px minimum.
    scale = min(1.0, 120.0 / max(size, 1)) if size > 120 else 1.0
    small = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1.0 else crop
    rects = face_detector(small, 0)
    if len(rects) != 1:
        return None
    t, r, b, l = _to_box(rects[0], scale, crop.shape)
    return (t + y0, r + x0, b + y0, l + x0)
