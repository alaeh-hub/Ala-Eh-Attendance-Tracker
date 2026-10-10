"""
Lighting normalisation applied just before a face is embedded.

CLAHE (contrast-limited adaptive histogram equalisation) on the luminance
channel evens out harsh side light, backlight and flat low-contrast
frames. It is applied only when the face region actually needs it: on a
well-lit face it would just add noise, and it must behave the same way at
enrollment and at the kiosk so both sides of a comparison are treated alike.
"""
import cv2
import numpy as np

LOW_CONTRAST_STD = 38.0     # luminance std-dev of the face crop
UNEVEN_RATIO = 1.30         # brighter half / darker half of the face
DIM_MEAN = 85.0
_CLIP_LIMIT = 2.0
_TILE = (8, 8)


def needs_enhancement(image_bgr: np.ndarray, face_box) -> bool:
    top, right, bottom, left = face_box
    crop = image_bgr[max(top, 0):bottom, max(left, 0):right]
    if crop.size == 0:
        return False
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    mid = gray.shape[1] // 2
    left_mean, right_mean = float(gray[:, :mid].mean()) + 1.0, float(gray[:, mid:].mean()) + 1.0
    uneven = max(left_mean, right_mean) / min(left_mean, right_mean) >= UNEVEN_RATIO
    return bool(gray.std() < LOW_CONTRAST_STD or uneven or gray.mean() < DIM_MEAN)


def apply_clahe(image_bgr: np.ndarray) -> np.ndarray:
    lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=_CLIP_LIMIT, tileGridSize=_TILE).apply(l)
    return cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)


def enhance_for_embedding(image_bgr: np.ndarray, face_box, enabled: bool = True) -> np.ndarray:
    """Returns the image to embed: CLAHE-normalised if the face needs it, else unchanged."""
    if enabled and needs_enhancement(image_bgr, face_box):
        return apply_clahe(image_bgr)
    return image_bgr
