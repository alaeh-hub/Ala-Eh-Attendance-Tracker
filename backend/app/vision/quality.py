"""
Frame quality gating before we ever generate an embedding. Rejecting bad
samples here is what keeps the embedding database clean — garbage in
means garbage matches out.
"""
import cv2
import numpy as np

MIN_FACE_FRACTION = 0.12      # face box height must be >= this fraction of image height
# Laplacian variance of the face crop; lower = blurrier. 60 rejected frames
# from typical webcams the instant autofocus was still catching up (e.g.
# right after moving closer to fill the guide oval), which read as
# genuinely sharp to the eye. Loosened so it only blocks real motion blur.
BLUR_THRESHOLD = 25.0
MIN_BRIGHTNESS = 40.0         # mean pixel intensity (0-255)
MAX_BRIGHTNESS = 220.0


def _laplacian_variance(gray: np.ndarray) -> float:
    return cv2.Laplacian(gray, cv2.CV_64F).var()


def assess_quality(image_bgr: np.ndarray, face_box, min_blur: float | None = None) -> dict:
    """
    face_box: (top, right, bottom, left) as returned by detector.py
    min_blur: sharpness floor; defaults to BLUR_THRESHOLD. Enrollment passes
    a stricter one, since a blurry saved sample hurts every later scan while
    the person enrolling can simply hold still and retry.
    Returns {"ok": bool, "reason": str|None, "score": float}
    score is a rough 0-1 composite used for ranking enrollment samples.
    """
    top, right, bottom, left = face_box
    h, w = image_bgr.shape[:2]
    face_h = bottom - top

    if face_h / float(h) < MIN_FACE_FRACTION:
        return {"ok": False, "reason": "Face is too small — move closer.", "score": 0.0}

    face_crop = image_bgr[max(top, 0):bottom, max(left, 0):right]
    if face_crop.size == 0:
        return {"ok": False, "reason": "Face crop invalid — try again.", "score": 0.0}

    gray = cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)

    blur_score = _laplacian_variance(gray)
    if blur_score < (BLUR_THRESHOLD if min_blur is None else min_blur):
        return {"ok": False, "reason": "Image is too blurry — hold still.", "score": 0.0}

    brightness = float(np.mean(gray))
    if brightness < MIN_BRIGHTNESS:
        return {"ok": False, "reason": "Too dark — improve lighting.", "score": 0.0}
    if brightness > MAX_BRIGHTNESS:
        return {"ok": False, "reason": "Too bright / overexposed.", "score": 0.0}

    # Composite score, normalized loosely into 0-1 for ranking purposes.
    size_score = min(1.0, (face_h / float(h)) / 0.4)
    blur_norm = min(1.0, blur_score / 300.0)
    brightness_norm = 1.0 - abs(brightness - 130) / 130.0
    score = round(0.4 * size_score + 0.4 * blur_norm + 0.2 * max(0.0, brightness_norm), 3)

    return {"ok": True, "reason": None, "score": score}


def face_sharpness(image_bgr_or_gray: np.ndarray, face_box) -> float:
    """Laplacian variance of the face crop — used to pick the sharpest burst frames."""
    top, right, bottom, left = face_box
    crop = image_bgr_or_gray[max(top, 0):bottom, max(left, 0):right]
    if crop.size == 0:
        return 0.0
    if crop.ndim == 3:
        crop = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    return float(_laplacian_variance(crop))
