"""
Face engines: one object that detects faces and turns them into
embeddings. Everything above this layer (services, routes) only sees
`Face` boxes and unit-length vectors, so engines are interchangeable.

  sface (default) — OpenCV YuNet detector + SFace recogniser (ONNX, CPU).
      ~10ms detection + ~13ms per embedding. 99.60% on LFW. Handles
      turned heads far better than HOG. Needs the two .onnx files in
      backend/models (see models/README.md).
  dlib — HOG detector + dlib ResNet (face_recognition). 99.38% on LFW,
      but ~300-900ms per embedding on this CPU. Used automatically if
      the ONNX files are missing.

Embeddings from different engines are NOT comparable; each stored
sample records the engine that produced it (FaceEmbedding.model) and
only samples from the active engine are matched.

Thresholds are cosine similarity on unit vectors, calibrated per engine
(see DEFAULTS). Sample-photo measurements, same person / different:
  dlib : 0.97 / up to 0.85      sface: 0.75 / at most 0.30
"""
import os
import threading
from dataclasses import dataclass

import cv2
import dlib
import numpy as np

from app.vision import detector as hog
from app.vision.embedding import embedding_provider as dlib_provider, normalize

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "models")
YUNET_PATH = os.path.join(MODELS_DIR, "face_detection_yunet_2023mar.onnx")
SFACE_PATH = os.path.join(MODELS_DIR, "face_recognition_sface_2021dec.onnx")
YUNET_WIDTH = 320


@dataclass
class Face:
    box: tuple  # (top, right, bottom, left), full-image pixels
    score: float
    landmarks: np.ndarray | None = None  # 5x2 (right eye, left eye, nose, mouth R, mouth L) — YuNet only
    raw: np.ndarray | None = None  # engine-specific detection row

    @property
    def area(self) -> int:
        return hog.box_area(self.box)

    def landmark_rect(self) -> dlib.rectangle:
        """
        A dlib-style square box for the 68-point landmark model (used for
        blink liveness). dlib's predictor expects HOG-shaped boxes; YuNet's
        are taller, so we rebuild one from the eye/mouth landmarks.
        """
        if self.landmarks is None:
            top, right, bottom, left = self.box
            return dlib.rectangle(int(left), int(top), int(right), int(bottom))
        eye_a, eye_b = self.landmarks[0], self.landmarks[1]
        mouth = (self.landmarks[3] + self.landmarks[4]) / 2
        eyes = (eye_a + eye_b) / 2
        half = float(np.linalg.norm(eye_b - eye_a)) * 1.1
        cx, cy = (eyes + mouth) / 2
        return dlib.rectangle(int(cx - half), int(cy - half * 0.95), int(cx + half), int(cy + half * 1.05))


class FaceEngine:
    name = "base"
    DEFAULTS: dict = {}

    def detect(self, image_bgr: np.ndarray, detection_width: int) -> list[Face]:
        raise NotImplementedError

    def embed(self, image_bgr: np.ndarray, face: Face, num_jitters: int = 1) -> np.ndarray:
        raise NotImplementedError

    def track(self, image_bgr: np.ndarray, previous: Face, detection_width: int) -> Face | None:
        """Cheap re-detection near a previous face; default is a full detect."""
        return None


def _gamma(image: np.ndarray, gamma: float) -> np.ndarray:
    table = ((np.arange(256) / 255.0) ** gamma * 255).astype(np.uint8)
    return cv2.LUT(image, table)


def _jitter_variants(aligned: np.ndarray) -> list:
    flipped = cv2.flip(aligned, 1)
    return [flipped, _gamma(aligned, 0.75), _gamma(aligned, 1.35), _gamma(flipped, 0.75), _gamma(flipped, 1.35)]


class SFaceEngine(FaceEngine):
    name = "sface"
    DEFAULTS = {
        # Official SFace operating point is 0.363 (balanced accuracy on
        # LFW). We run stricter for attendance: a wrong-person clock-in is
        # worse than asking someone to rescan. Measured on all of LFW
        # (588 enrolled people, single photos, 6,211 stranger probes) with
        # tools/evaluate_accuracy.py: 0.45 accepted 0.92% of strangers,
        # 0.50 accepts ~0.2% for ~1.3% rejects (burst voting does better).
        "FACE_MATCH_THRESHOLD": 0.50,
        "FACE_AMBIGUITY_MARGIN": 0.08,
        # Variants averaged per kiosk frame: the original plus its mirror
        # image. Enrollment averages several variants, so a single raw
        # probe would be compared against a differently-smoothed vector.
        "KIOSK_JITTERS": 2,
        "ENROLL_CONSISTENCY_THRESHOLD": 0.38,
        "ENROLL_DUPLICATE_THRESHOLD": 0.45,
        "LOW_CONFIDENCE_BAND": 0.08,
        "OUTLIER_SIMILARITY": 0.55,
        "EARLY_EXIT_MARGIN": 0.10,
    }

    def __init__(self):
        # OpenCV DNN objects are not thread-safe; the lock is uncontended
        # in the single-worker deployment but keeps the dev server safe.
        self._lock = threading.Lock()
        self._detector = cv2.FaceDetectorYN.create(YUNET_PATH, "", (320, 320), 0.75, 0.3, 50)
        self._recognizer = cv2.FaceRecognizerSF.create(SFACE_PATH, "")

    def detect(self, image_bgr: np.ndarray, detection_width: int) -> list[Face]:
        h, w = image_bgr.shape[:2]
        # YuNet is accurate on small inputs; 320px wide still gives a kiosk
        # face ~100px, and costs a fraction of a larger pass.
        target = min(w, YUNET_WIDTH)
        scale = target / float(w)
        small = cv2.resize(image_bgr, (target, int(round(h * scale))), interpolation=cv2.INTER_AREA) if scale < 1 else image_bgr
        with self._lock:
            self._detector.setInputSize((small.shape[1], small.shape[0]))
            _, rows = self._detector.detect(small)
        faces = []
        for row in rows if rows is not None else []:
            row = row.copy()
            if scale < 1:
                row[:14] /= scale
            x, y, fw, fh = row[:4]
            box = (max(int(y), 0), min(int(x + fw), w), min(int(y + fh), h), max(int(x), 0))
            faces.append(Face(box=box, score=float(row[14]), landmarks=row[4:14].reshape(5, 2), raw=row))
        faces.sort(key=lambda f: f.area, reverse=True)
        return faces

    def track(self, image_bgr: np.ndarray, previous: Face, detection_width: int) -> Face | None:
        """
        Re-detect inside a crop around the previous face (people barely move
        between burst frames), resized so the face is ~80px. That input is
        ~1/10 the pixels of a full-frame pass, so tracking is much cheaper.
        """
        top, right, bottom, left = previous.box
        h, w = image_bgr.shape[:2]
        size = max(bottom - top, right - left)
        pad = int(size * 0.5)
        y0, y1 = max(top - pad, 0), min(bottom + pad, h)
        x0, x1 = max(left - pad, 0), min(right + pad, w)
        crop = image_bgr[y0:y1, x0:x1]
        if crop.size == 0:
            return None
        scale = min(1.0, 80.0 / max(size, 1))
        small = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else crop
        with self._lock:
            self._detector.setInputSize((small.shape[1], small.shape[0]))
            _, rows = self._detector.detect(small)
        if rows is None or len(rows) != 1:
            return None
        row = rows[0].copy()
        row[:14] /= scale
        # Row layout: x, y, w, h, then 5 (x, y) landmarks. Offset positions only.
        row[[0, 4, 6, 8, 10, 12]] += x0
        row[[1, 5, 7, 9, 11, 13]] += y0
        x, y, fw, fh = row[:4]
        box = (max(int(y), 0), min(int(x + fw), w), min(int(y + fh), h), max(int(x), 0))
        return Face(box=box, score=float(row[14]), landmarks=row[4:14].reshape(5, 2), raw=row)

    def embed(self, image_bgr: np.ndarray, face: Face, num_jitters: int = 1) -> np.ndarray:
        with self._lock:
            aligned = self._recognizer.alignCrop(image_bgr, face.raw)
            vectors = [self._recognizer.feature(aligned).flatten()]
            # "Jitter" for enrollment: embed extra variants of the aligned
            # crop (mirrored, brighter, darker) and average them. Faces are
            # near-symmetric and enrollment light is never the kiosk's
            # light, so this reduces pose and exposure bias. Capped at the
            # number of variants in _jitter_variants.
            for variant in _jitter_variants(aligned)[: max(num_jitters - 1, 0)]:
                vectors.append(self._recognizer.feature(variant).flatten())
        return normalize(np.mean([normalize(v) for v in vectors], axis=0))


class DlibEngine(FaceEngine):
    name = "dlib"
    DEFAULTS = {
        # Raw dlib vectors have norm ~1.39; dlib's 0.6 raw-distance rule
        # (99.38% LFW) maps to cosine ~0.91.
        "FACE_MATCH_THRESHOLD": 0.91,
        "FACE_AMBIGUITY_MARGIN": 0.03,
        # dlib jitters are random re-crops at ~300-900ms each: too slow to repeat per frame.
        "KIOSK_JITTERS": 1,
        "ENROLL_CONSISTENCY_THRESHOLD": 0.87,
        "ENROLL_DUPLICATE_THRESHOLD": 0.91,
        "LOW_CONFIDENCE_BAND": 0.05,
        "OUTLIER_SIMILARITY": 0.90,
        "EARLY_EXIT_MARGIN": 0.03,
    }

    def detect(self, image_bgr, detection_width):
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        return [Face(box=b, score=s) for b, s in hog.detect_faces(rgb, detection_width)]

    def track(self, image_bgr, previous, detection_width):
        box = hog.detect_in_region(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB), previous.box, detection_width)
        return Face(box=box, score=previous.score) if box else None

    def embed(self, image_bgr, face, num_jitters=1):
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        return dlib_provider.generate_embedding(rgb, face.box, num_jitters)


_engine: FaceEngine | None = None
_engine_lock = threading.Lock()


def sface_available() -> bool:
    return os.path.exists(YUNET_PATH) and os.path.exists(SFACE_PATH)


def get_engine(preferred: str = "auto") -> FaceEngine:
    global _engine
    with _engine_lock:
        wanted = preferred.lower()
        if wanted == "auto":
            wanted = "sface" if sface_available() else "dlib"
        if _engine is None or _engine.name != wanted:
            if wanted == "sface" and not sface_available():
                raise RuntimeError(f"FACE_ENGINE=sface but model files are missing in {MODELS_DIR}")
            _engine = SFaceEngine() if wanted == "sface" else DlibEngine()
        return _engine


def pick_single_face(faces: list[Face], allow_dominant: bool):
    """Returns (face, error). Mirrors detector.detect_single_face for any engine."""
    if not faces:
        return None, "No face detected. Move into frame and try again."
    if len(faces) > 1:
        dominant = faces[0].area >= hog.DOMINANT_FACE_AREA_RATIO * faces[1].area
        if not (allow_dominant and dominant):
            return None, "Multiple faces detected. Only one person should be visible."
    return faces[0], None
