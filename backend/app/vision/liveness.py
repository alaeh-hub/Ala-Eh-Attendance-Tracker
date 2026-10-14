"""
Blink-based liveness using the Eye Aspect Ratio (EAR) technique
(Soukupova & Cech, 2016) on 68-point-style eye landmarks.

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
person who blinks in any scan within a few seconds passes. The recogniser
(face_service.recognize_burst) only contributes EARs from the same face
track that produced the identity, and spot-checks the closed-eye frame's
identity, so a blink cannot be borrowed from a second face.

This is NOT full anti-spoofing: a replayed video of the person blinking
can still pass. Passive anti-spoofing lives in vision/antispoof.py.

Landmark model and licensing
----------------------------
Eye landmarks come from a pluggable EyeLandmarkSource. The default,
"dlib68", is dlib's ``shape_predictor_68_face_landmarks.dat`` shipped by
face_recognition_models. That model was trained on the iBUG 300-W dataset,
whose licence EXCLUDES COMMERCIAL USE. Before a commercial deployment,
register a source backed by a commercially licensed landmark model
(``register_eye_landmark_source(name, source)``) and select it with the
``LIVENESS_LANDMARK_MODEL`` config key; nothing else has to change. A
source only has to return the six eye-contour points per eye in the
68-point ordering (points 36-41 and 42-47).
"""
import logging
import threading
import time
from typing import Protocol

import cv2
import dlib
import numpy as np

from app.vision._locks import native_lock

logger = logging.getLogger("app.liveness")

MIN_EAR_SAMPLES = 4
CLOSED_RATIO = 0.75   # both eyes must fall to <= 75% of baseline
OPEN_RATIO = 0.90     # "open" frames are >= 90% of baseline
MIN_OPEN_FRAMES = 2
LANDMARK_FACE_PX = 220  # face width used for landmark fitting

# Name of the default eye-landmark source (see module docstring for licensing).
LIVENESS_LANDMARK_MODEL = "dlib68"


class EyeLandmarkSource(Protocol):
    """Anything that fits eye contours on a face crop."""

    def eye_landmarks(self, image: np.ndarray, rect: dlib.rectangle) -> tuple[np.ndarray, np.ndarray]:
        """(left_eye, right_eye) as 6x2 float arrays (68-point order) for the face in `rect`."""
        ...


class Dlib68EyeLandmarks:
    """dlib 68-point shape predictor (iBUG 300-W: non-commercial licence terms)."""

    def __init__(self):
        self._lock = native_lock()  # dlib predictors are not safe to share across OS threads

    def eye_landmarks(self, image, rect):
        from app.vision.embedding import embedding_provider  # loads face_recognition models lazily

        with self._lock:
            return embedding_provider.eye_landmarks(image, rect)


_sources: dict[str, EyeLandmarkSource] = {}
_sources_lock = threading.Lock()


def register_eye_landmark_source(name: str, source: EyeLandmarkSource) -> None:
    with _sources_lock:
        _sources[name.lower()] = source


def get_eye_landmark_source(name: str | None = None) -> EyeLandmarkSource:
    """The source registered as `name` (default LIVENESS_LANDMARK_MODEL); unknown names fall back to dlib68."""
    wanted = (name or LIVENESS_LANDMARK_MODEL).lower()
    with _sources_lock:
        if "dlib68" not in _sources:
            _sources["dlib68"] = Dlib68EyeLandmarks()
        source = _sources.get(wanted)
        if source is None:
            logger.warning("unknown LIVENESS_LANDMARK_MODEL %r; using dlib68", name)
            source = _sources["dlib68"]
        return source


def eye_aspect_ratio(eye: np.ndarray) -> float:
    a = np.linalg.norm(eye[1] - eye[5])
    b = np.linalg.norm(eye[2] - eye[4])
    c = np.linalg.norm(eye[0] - eye[3])
    if c == 0:
        return 0.0
    return float((a + b) / (2.0 * c))


def frame_ear(image: np.ndarray, rect: dlib.rectangle,
              source: EyeLandmarkSource | None = None) -> tuple[float, float] | None:
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
        left, right = (source or get_eye_landmark_source()).eye_landmarks(crop, local)
    except Exception:  # noqa: BLE001 - a landmark failure just means "no EAR for this frame"
        return None
    return eye_aspect_ratio(left), eye_aspect_ratio(right)


def blink_candidate(samples: list, blink_delta_threshold: float) -> int | None:
    """
    Index of the frame most likely to be a closed-eye frame in ONE burst's
    EARs, or None when no frame dips noticeably. Deliberately looser than
    evaluate_blink (half the blink delta, measured against the most open
    frame, not the median): EARs are pooled across scans, so a frame that is
    only "closed" relative to an earlier scan's baseline must be caught too.
    The caller embeds this frame to confirm it shows the identified person.
    """
    if len(samples) < 2:
        return None
    means = _as_pairs(samples).mean(axis=1)
    lowest = int(np.argmin(means))
    if float(means.max() - means[lowest]) >= 0.5 * blink_delta_threshold:
        return lowest
    return None


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

    def discard(self, key: tuple) -> None:
        """Forget pooled samples for one (device, user), e.g. after a scan
        whose blink belonged to a different face than the matched one."""
        with self._lock:
            self._samples.pop(key, None)

    def clear(self):
        with self._lock:
            self._samples.clear()


liveness_tracker = LivenessTracker()
