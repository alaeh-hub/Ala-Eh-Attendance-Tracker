"""
Vectorised similarity matching against enrolled embeddings.

All enrolled vectors live in one float32 matrix (see EmbeddingIndex in
services/embedding_index.py); a single matrix-vector product scores
every sample at once — tens of thousands of samples in well under a
millisecond — instead of a Python loop over JSON-decoded rows.

Per-user score = 0.7 * best single sample + 0.3 * similarity to the
user's centroid. The max rewards the closest pose; the centroid term
stabilises the score so one odd sample can't carry a match alone.
"""
import numpy as np

MAX_WEIGHT = 0.7
CENTROID_WEIGHT = 0.3
LOW_CONFIDENCE_BAND = 0.05


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def rank_users(query: np.ndarray, matrix: np.ndarray, owners: np.ndarray,
               centroids: np.ndarray, centroid_owners: list) -> list:
    """
    query: (128,) unit vector. matrix: (N,128) unit vectors, owners: (N,)
    index into centroid_owners for each row. Returns [(user_id, score)]
    sorted descending.
    """
    if matrix.size == 0:
        return []
    sample_scores = matrix @ query
    best = np.full(len(centroid_owners), -1.0, dtype=np.float32)
    np.maximum.at(best, owners, sample_scores)
    centroid_scores = centroids @ query
    combined = MAX_WEIGHT * best + CENTROID_WEIGHT * centroid_scores
    order = np.argsort(-combined)
    return [(centroid_owners[i], float(combined[i])) for i in order]


def classify_match(ranked_matches, threshold: float, ambiguity_margin: float,
                   low_confidence_band: float = LOW_CONFIDENCE_BAND):
    """
    Turns a ranked (user_id, score) list into a decision. Never returns a
    bare name — always a structured status the caller must handle.
    """
    if not ranked_matches:
        return {"status": "NO_MATCH", "user_id": None, "score": 0.0, "runner_up_score": None}

    best_user, best_score = ranked_matches[0]
    runner_up_score = ranked_matches[1][1] if len(ranked_matches) > 1 else None

    if best_score < threshold:
        # Just under the threshold is "close but not sure" (bad light,
        # angle); anything further is treated as an unknown person.
        return {
            "status": "LOW_CONFIDENCE" if best_score >= threshold - low_confidence_band else "NO_MATCH",
            "user_id": None,
            "score": best_score,
            "runner_up_score": runner_up_score,
        }

    if runner_up_score is not None and (best_score - runner_up_score) < ambiguity_margin:
        return {"status": "AMBIGUOUS_MATCH", "user_id": None, "score": best_score, "runner_up_score": runner_up_score}

    return {"status": "MATCHED", "user_id": best_user, "score": best_score, "runner_up_score": runner_up_score}
