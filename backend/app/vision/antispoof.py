"""
Passive anti-spoofing: is this a live face or a photo / screen?

Two layers:

1. MiniFASNet (Silent-Face-Anti-Spoofing) ONNX models, when present in
   backend/models. This is the real defence: a CNN trained on print and
   replay attacks. Expected files (see models/README.md):
       2.7_80x80_MiniFASNetV2.onnx        (crop scale 2.7)
       4_0_0_80x80_MiniFASNetV1SE.onnx    (crop scale 4.0)
   Either one alone works; two are averaged.

2. A texture heuristic (moire / periodic screen pattern, plus flat
   low-detail prints). It is deliberately conservative and only ever a
   weak signal: with no models installed the default SPOOF_MODE=auto only
   *logs* it and never blocks a check-in.

Blink liveness (vision/liveness.py) stays on as the active challenge;
this layer is what stops a photo of a coworker that includes open eyes.
"""
import glob
import logging
import os

import cv2
import numpy as np

from app.vision._locks import native_lock
from app.vision.engines import MODELS_DIR

logger = logging.getLogger("app.antispoof")

MODEL_SCALES = {"MiniFASNetV2": 2.7, "MiniFASNetV1SE": 4.0}
INPUT_SIZE = 80
MODEL_DEFAULT_THRESHOLD = 0.55
HEURISTIC_DEFAULT_THRESHOLD = 0.35


def _crop_scaled(image: np.ndarray, box, scale: float) -> np.ndarray:
    """Silent-Face's CropImage: crop around the face at `scale`, shifted to stay in frame."""
    top, right, bottom, left = box
    h, w = image.shape[:2]
    bw, bh = right - left, bottom - top
    scale = min((h - 1) / max(bh, 1), (w - 1) / max(bw, 1), scale)
    nw, nh = bw * scale, bh * scale
    cx, cy = left + bw / 2, top + bh / 2
    x0, y0 = cx - nw / 2, cy - nh / 2
    x1, y1 = cx + nw / 2, cy + nh / 2
    if x0 < 0:
        x1, x0 = x1 - x0, 0
    if y0 < 0:
        y1, y0 = y1 - y0, 0
    if x1 > w - 1:
        x0, x1 = x0 - (x1 - (w - 1)), w - 1
    if y1 > h - 1:
        y0, y1 = y0 - (y1 - (h - 1)), h - 1
    x0, y0 = max(int(x0), 0), max(int(y0), 0)
    crop = image[y0:int(y1) + 1, x0:int(x1) + 1]
    return cv2.resize(crop, (INPUT_SIZE, INPUT_SIZE))


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - np.max(x))
    return e / e.sum()


def texture_realness(image_bgr: np.ndarray, face_box) -> float:
    """
    0 (very likely a screen/print) .. 1 (looks like skin). Looks for
    periodic high-frequency peaks (moire from a display's pixel grid or a
    camera re-photographing one) and for an unnaturally flat, detail-poor
    face. Uncalibrated: treat as a hint.
    """
    top, right, bottom, left = face_box
    crop = image_bgr[max(top, 0):bottom, max(left, 0):right]
    if crop.size == 0:
        return 1.0
    gray = cv2.cvtColor(cv2.resize(crop, (128, 128), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    gray -= gray.mean()
    window = np.outer(np.hanning(128), np.hanning(128)).astype(np.float32)
    spectrum = np.abs(np.fft.fftshift(np.fft.fft2(gray * window)))
    yy, xx = np.indices(spectrum.shape)
    radius = np.hypot(yy - 64, xx - 64)
    band = (radius > 24) & (radius < 60)          # mid/high spatial frequencies
    values = spectrum[band]
    if values.size == 0:
        return 0.5
    if np.median(values) < 1e-6:
        return 0.2   # no texture at all: a flat print or a blank frame
    peak_ratio = float(np.percentile(values, 99.9) / np.median(values))
    # Natural skin spectra decay smoothly; a pixel grid produces isolated
    # spikes well above that.
    moire = float(np.clip((peak_ratio - 45.0) / 80.0, 0.0, 1.0))

    detail = float(cv2.Laplacian(gray, cv2.CV_32F).var())
    flat = float(np.clip((12.0 - detail) / 12.0, 0.0, 1.0))
    return round(1.0 - max(moire, 0.6 * flat), 3)


class AntiSpoof:
    def __init__(self):
        self._lock = native_lock()  # cv2.dnn nets are not thread-safe; called from tpool threads
        self._nets: list = []
        for path in sorted(glob.glob(os.path.join(MODELS_DIR, "*MiniFASNet*.onnx"))):
            name = os.path.basename(path)
            scale = next((s for key, s in MODEL_SCALES.items() if key in name), None)
            if scale is None:
                continue
            try:
                self._nets.append((scale, cv2.dnn.readNetFromONNX(path)))
                logger.info("anti-spoof model loaded: %s (scale %s)", name, scale)
            except cv2.error as exc:
                logger.warning("could not load anti-spoof model %s: %s", name, exc)

    @property
    def has_model(self) -> bool:
        return bool(self._nets)

    def score(self, image_bgr: np.ndarray, face_box) -> dict:
        """{"score": 0-1 realness, "method": "model"|"texture"}"""
        if self._nets:
            probs = []
            with self._lock:
                for scale, net in self._nets:
                    blob = _crop_scaled(image_bgr, face_box, scale).astype(np.float32).transpose(2, 0, 1)[None]
                    net.setInput(blob)
                    out = net.forward().flatten()
                    probs.append(float(_softmax(out)[1]))   # class 1 = real face
            return {"score": round(float(np.mean(probs)), 3), "method": "model"}
        return {"score": texture_realness(image_bgr, face_box), "method": "texture"}


_instance = None
_instance_lock = native_lock()


def get_antispoof() -> AntiSpoof:
    global _instance
    with _instance_lock:
        if _instance is None:
            _instance = AntiSpoof()
        return _instance


def resolve_mode(configured: str, has_model: bool) -> str:
    mode = (configured or "auto").lower()
    if mode == "auto":
        return "enforce" if has_model else "log"
    return mode if mode in ("off", "log", "enforce") else "log"


def default_threshold(method: str) -> float:
    return MODEL_DEFAULT_THRESHOLD if method == "model" else HEURISTIC_DEFAULT_THRESHOLD
