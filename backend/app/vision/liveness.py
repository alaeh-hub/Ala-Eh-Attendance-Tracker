"""
Blink-based liveness using the Eye Aspect Ratio (EAR) technique
(Soukupova & Cech, 2016) on dlib's 68-point landmarks.

A photo or paused video has (nearly) constant eye openness; a live blink
makes BOTH eyes close together for 100-400ms. Measured on a still photo,
landmark noise alone moves EAR by up to ~9% between frames — so a naive
"max - min" range test lets photos through once enough frames are
pooled. The rules below are built to reject that noise:

  * landmarks are fitted on an upscaled face crop (less pixel noise);
  * baseline = per-eye MEDIAN over the pooled frames (open eyes dominate);
  * a frame counts as "closed" only if BOTH eyes drop to <= 75% of their
    own baseline AND the mean drop is >= blink_delta (absolute);
  * at least two clearly open frames must surround it.

Samples are pooled across consecutive kiosk scans (LivenessTracker), so a
person who blinks in any scan within a few seconds passes.

This is NOT full anti-spoofing: a replayed video of the person blinking
can still pass. Add a dedicated anti-spoof model behind evaluate_blink()
for high-security sites.
"""
import threading
import time

import cv2
import dlib
import numpy as np

from app.vision.embedding import embedding_provider

MIN_EAR_SAMPLES = 4
CLOSED_RATIO = 0.75   # both eyes must fall to <= 75% of baseline
OPEN_RATIO = 0.90     # "open" frames are >= 90% of baseline
MIN_OPEN_FRAMES = 2
LANDMARK_FACE_PX = 220  # face width used for landmark fitting


def eye_aspect_ratio(eye: np.ndarray) -> float:
    a = np.linalg.norm(eye[1] - eye[5])
    b = np.linalg.norm(eye[2] - eye[4])
    c = np.linalg.norm(eye[0] - eye[3])
    if c == 0:
        return 0.0
    return float((a + b) / (2.0 * c))


def frame_ear(image: np.ndarray, rect: dlib.rectangle) -> tuple[float, float] | None:
    """
    (left EAR, right EAR) for one frame. `rect` is a dlib.rectangle (see
    Face.landmark_rect). The face is cropped and upscaled to ~220px wide
    first: on a 640px webcam frame the eye is only ~20px wide, and a
    one-pixel landmark error there is a 5-10% EAR error.
    """
    try:
        h, w = image.shape[:2]
        size = max(rect.width(), 1)
        pad = int(size * 0.25)
        x0, y0 = max(rect.left() - pad, 0), max(rect.top() - pad, 0)
        x1, y1 = min(rect.right() + pad, w), min(rect.bottom() + pad, h)
        crop = image[y0:y1, x0:x1]
        scale = LANDMARK_FACE_PX / float(size)
        if crop.size == 0:
            return None
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
        local = dlib.rectangle(
            int((rect.left() - x0) * scale), int((rect.top() - y0) * scale),
            int((rect.right() - x0) * scale), int((rect.bottom() - y0) * scale),
        )
        left, right = embedding_provider.eye_landmarks(crop, local)
    except Exception:
        return None
    return eye_aspect_ratio(left), eye_aspect_ratio(right)


def _as_pairs(samples: list) -> np.ndarray:
    # Accept plain floats (mean EAR) for backwards compatibility.
    return np.asarray([(s, s) if np.isscalar(s) else s for s in samples], dtype=np.float32).reshape(-1, 2)


def evaluate_blink(samples: list, blink_delta_threshold: float) -> dict:
    """samples: [(left_ear, right_ear)] (or plain floats) across the pooled frames."""
    if len(samples) < MIN_EAR_SAMPLES:
        return {"passed": False, "reason": "Not enough frames to assess liveness.", "ear_range": 0.0}

    ears = _as_pairs(samples)
    baseline = np.median(ears, axis=0)
    if np.any(baseline <= 0):
        return {"passed": False, "reason": "Eyes not visible — remove glasses glare and face the camera.", "ear_range": 0.0}

    ratios = ears / baseline
    mean_drop = baseline.mean() - ears.mean(axis=1)
    closed = np.all(ratios <= CLOSED_RATIO, axis=1) & (mean_drop >= blink_delta_threshold)
    open_frames = int(np.all(ratios >= OPEN_RATIO, axis=1).sum())
    deepest = float(mean_drop.max())

    if closed.any() and open_frames >= MIN_OPEN_FRAMES:
        return {"passed": True, "reason": None, "ear_range": round(deepest, 4)}
    return {"passed": False, "reason": "No blink detected — please blink naturally.", "ear_range": round(deepest, 4)}


def check_liveness_from_frames(frames_with_boxes: list, blink_delta_threshold: float) -> dict:
    """Single-burst check. frames_with_boxes: [(image, dlib.rectangle)]."""
    ears = [e for e in (frame_ear(img, rect) for img, rect in frames_with_boxes) if e is not None]
    return evaluate_blink(ears, blink_delta_threshold)


class LivenessTracker:
    """
    In-memory pool of recent EAR samples keyed by (device, user). The app
    runs as a single worker (see run.py), so process memory is shared by
    all requests. Samples expire after `window_seconds`.
    """

    MAX_SAMPLES = 40

    def __init__(self):
        self._lock = threading.Lock()
        self._samples: dict[tuple, list[tuple[float, object]]] = {}

    def add_and_evaluate(self, key: tuple, ears: list, window_seconds: float, blink_delta: float) -> dict:
        now = time.monotonic()
        with self._lock:
            # Drop stale keys so memory stays bounded.
            for k in [k for k, v in self._samples.items() if not v or now - v[-1][0] > window_seconds]:
                del self._samples[k]
            pool = [s for s in self._samples.get(key, []) if now - s[0] <= window_seconds]
            pool.extend((now, e) for e in ears)
            self._samples[key] = pool[-self.MAX_SAMPLES:]
            result = evaluate_blink([e for _, e in self._samples[key]], blink_delta)
            if result["passed"]:
                # A blink is single-use: the next check-in must blink again.
                self._samples.pop(key, None)
            return result

    def clear(self):
        with self._lock:
            self._samples.clear()


liveness_tracker = LivenessTracker()
