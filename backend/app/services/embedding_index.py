"""
In-memory index of every active employee's enrolled embeddings.

Before: each check-in re-read every FaceEmbedding row and JSON-decoded
each vector, then compared them one by one in Python. Now the vectors
are loaded once into a float32 matrix and every enrollment change bumps
a version so the next request rebuilds it. Matching a frame is a single
matrix-vector product.
"""
import json

import numpy as np

from app.extensions import db
from app.models.face_embedding import FaceEmbedding
from app.models.user import User
from app.vision._locks import native_lock
from app.vision.embedding import normalize
from app.vision.engines import get_engine
from app.vision.matcher import rank_users


def active_engine():
    from flask import current_app
    return get_engine(current_app.config.get("FACE_ENGINE", "auto"))


def model_filter(engine_name: str):
    """SQL filter for samples produced by the given engine (NULL = legacy dlib)."""
    if engine_name == "dlib":
        return (FaceEmbedding.model == "dlib") | FaceEmbedding.model.is_(None)
    return FaceEmbedding.model == engine_name


class EmbeddingIndex:
    def __init__(self):
        # Shared by request greenlets and eventlet.tpool recognition threads,
        # so it must be an OS lock; it is never held across database I/O.
        self._lock = native_lock()
        self._dirty = True
        self._generation = 0  # bumped by every invalidate()
        self._installed_generation = -1  # generation the cached matrix was loaded at
        self._matrix = np.zeros((0, 0), dtype=np.float32)
        self._owners = np.zeros(0, dtype=np.int64)
        self._user_ids: list[str] = []
        self._centroids = np.zeros((0, 0), dtype=np.float32)

    def invalidate(self):
        # Every invalidate bumps the generation, so a rebuild that started
        # before it can never mark the index clean (see _snapshot).
        with self._lock:
            self._dirty = True
            self._generation += 1

    def _load(self):
        """Read and normalise the active engine's samples (no lock held)."""
        rows = (
            db.session.query(FaceEmbedding.user_id, FaceEmbedding.vector_json)
            .join(User, User.id == FaceEmbedding.user_id)
            .filter(User.is_active.is_(True), model_filter(active_engine().name))
            .all()
        )
        user_ids, owners, vectors = [], [], []
        position = {}
        dim = None
        for user_id, vector_json in rows:
            try:
                vec = np.asarray(FaceEmbedding.decode(vector_json), dtype=np.float32)
            except (TypeError, ValueError, json.JSONDecodeError):
                # A damaged legacy row must not take down every recognition
                # request. It is ignored until an administrator re-enrolls it.
                continue
            if vec.ndim != 1 or vec.size == 0 or not np.all(np.isfinite(vec)):
                continue
            norm = np.linalg.norm(vec)
            if norm == 0:
                continue
            vec = vec / norm
            dim = dim or vec.shape[0]
            if vec.shape[0] != dim:
                continue
            if user_id not in position:
                position[user_id] = len(user_ids)
                user_ids.append(user_id)
            owners.append(position[user_id])
            vectors.append(vec)

        matrix = np.vstack(vectors) if vectors else np.zeros((0, 0), dtype=np.float32)
        owners_arr = np.asarray(owners, dtype=np.int64)
        centroids = np.zeros((len(user_ids), dim or 0), dtype=np.float32)
        if vectors:
            np.add.at(centroids, owners_arr, matrix)
            norms = np.linalg.norm(centroids, axis=1, keepdims=True)
            centroids = centroids / np.where(norms == 0, 1, norms)

        return matrix, owners_arr, centroids, user_ids

    def _snapshot(self):
        with self._lock:
            if not self._dirty:
                return self._matrix, self._owners, self._centroids, self._user_ids
            generation = self._generation
        # Rebuild outside the lock: the query must not stall (or, under
        # eventlet, deadlock) every other scan. Two concurrent rebuilds just
        # do the same work twice.
        loaded = self._load()
        with self._lock:
            # A slower, older rebuild must not overwrite a newer one.
            if generation >= self._installed_generation:
                self._matrix, self._owners, self._centroids, self._user_ids = loaded
                self._installed_generation = generation
            # An invalidate() during the load means it may be stale already:
            # use it for this call, but rebuild again on the next one.
            if self._generation == generation:
                self._dirty = False
        return loaded

    def rank(self, query: np.ndarray, exclude_user_id: str | None = None) -> list:
        matrix, owners, centroids, user_ids = self._snapshot()
        if matrix.size == 0 or matrix.shape[1] != query.shape[0]:
            return []
        ranked = rank_users(query, matrix, owners, centroids, user_ids)
        if exclude_user_id:
            ranked = [r for r in ranked if r[0] != exclude_user_id]
        return ranked

    @property
    def size(self) -> int:
        return int(self._snapshot()[0].shape[0])


embedding_index = EmbeddingIndex()
