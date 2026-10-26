"""
FaceEmbeddingProvider abstraction — this is the ONE seam you touch to
swap the underlying model (e.g. move from dlib's ResNet embedding to
ArcFace/InsightFace) without rewriting the services or routes.

The dlib provider calls the models face_recognition loads directly, so
we can (a) compute landmarks once and reuse them for both the embedding
and liveness, and (b) control re-sampling ("jitters") per call:
enrollment uses several jitters for a cleaner reference vector, while
kiosk recognition uses one for speed.
"""
from abc import ABC, abstractmethod

import dlib
import numpy as np
from face_recognition.api import face_encoder, pose_predictor_5_point, pose_predictor_68_point

EMBEDDING_DIM = 128


class FaceEmbeddingProvider(ABC):
    @abstractmethod
    def generate_embedding(self, image_rgb: np.ndarray, face_box, num_jitters: int = 1) -> np.ndarray:
        ...

    @staticmethod
    def validate_embedding(embedding: np.ndarray) -> bool:
        return (
            embedding is not None
            and embedding.ndim == 1
            and embedding.shape[0] > 0
            and bool(np.all(np.isfinite(embedding)))
        )


def _rect(face_box) -> dlib.rectangle:
    top, right, bottom, left = face_box
    return dlib.rectangle(int(left), int(top), int(right), int(bottom))


def normalize(vector: np.ndarray) -> np.ndarray:
    vector = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    return vector if norm == 0 else vector / norm


class DlibEmbeddingProvider(FaceEmbeddingProvider):
    """
    dlib's 128-d ResNet face descriptor (99.38% on LFW), L2-normalised so
    cosine similarity is a plain dot product. Alignment uses the 5-point
    landmark model — the one this descriptor was trained with, and the
    same one used for every embedding already stored.
    """

    def generate_embedding(self, image_rgb: np.ndarray, face_box, num_jitters: int = 1) -> np.ndarray:
        shape = pose_predictor_5_point(image_rgb, _rect(face_box))
        descriptor = face_encoder.compute_face_descriptor(image_rgb, shape, max(1, int(num_jitters)))
        return normalize(np.array(descriptor))

    @staticmethod
    def face_landmarks(image: np.ndarray, rect: dlib.rectangle) -> np.ndarray:
        """All 68 points as a 68x2 array (RGB or grayscale image)."""
        shape = pose_predictor_68_point(image, rect)
        return np.array([[p.x, p.y] for p in shape.parts()], dtype=np.float32)

    @staticmethod
    def eye_landmarks(image: np.ndarray, rect: dlib.rectangle):
        """(left_eye, right_eye) as 6x2 arrays from the 68-point model (RGB or grayscale image)."""
        pts = DlibEmbeddingProvider.face_landmarks(image, rect)
        return pts[36:42], pts[42:48]


# Single instance used throughout the app. Swap this line to change models globally.
embedding_provider = DlibEmbeddingProvider()
