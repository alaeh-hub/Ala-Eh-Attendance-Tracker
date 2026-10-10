"""
Accuracy measurement for the matcher: false accept / false reject rates at
a range of thresholds, so the match threshold can be chosen from data.

Pure numpy, no database and no camera. tools/evaluate_accuracy.py builds
the inputs from a folder of labelled photos.

Definitions (per probe image):
  * genuine probe  - an enrolled person. Rejected (FRR) if the best match is
    below the threshold, ambiguous, or the wrong person.
  * impostor probe - someone NOT enrolled. Falsely accepted (FAR) if the best
    match reaches the threshold and is not ambiguous.
  * a genuine probe matched to the WRONG person counts as a false accept
    too: for attendance that is the worst error (someone else's punch).
"""
from dataclasses import dataclass

import numpy as np

from app.vision.matcher import rank_users


@dataclass
class Point:
    threshold: float
    far: float          # impostor/wrong-person accepted
    frr: float          # genuine person rejected
    wrong_person: float  # genuine probes matched to someone else


def build_gallery(samples_by_person: dict):
    """{person: (n, d) unit vectors} -> matrix, owners, centroids, person_ids for rank_users."""
    ids = list(samples_by_person)
    matrix = np.vstack([samples_by_person[i] for i in ids]).astype(np.float32)
    owners = np.concatenate([np.full(len(samples_by_person[i]), k) for k, i in enumerate(ids)])
    centroids = np.vstack([samples_by_person[i].mean(axis=0) for i in ids]).astype(np.float32)
    centroids /= np.where(np.linalg.norm(centroids, axis=1, keepdims=True) == 0, 1, np.linalg.norm(centroids, axis=1, keepdims=True))
    return matrix, owners, centroids, ids


def _best_two(query, gallery):
    ranked = rank_users(query, *gallery[:3], gallery[3])
    best_id, best = ranked[0]
    runner = ranked[1][1] if len(ranked) > 1 else None
    return best_id, best, runner


def compute_curve(gallery, genuine_probes: list, impostor_probes: list, thresholds, margin: float):
    """
    genuine_probes: [(person_id, vector)], impostor_probes: [vector].
    Returns list[Point] across `thresholds`.
    """
    genuine = [(pid, *_best_two(vec, gallery)) for pid, vec in genuine_probes]
    impostor = [_best_two(vec, gallery) for vec in impostor_probes]

    def accepted(score, runner, t):
        return score >= t and not (runner is not None and score - runner < margin)

    points = []
    for t in thresholds:
        rejected = wrong = 0
        for pid, best_id, score, runner in genuine:
            if not accepted(score, runner, t):
                rejected += 1
            elif best_id != pid:
                wrong += 1
        false_accepts = sum(1 for _, score, runner in impostor if accepted(score, runner, t))
        n_g, n_i = max(len(genuine), 1), max(len(impostor), 1)
        far = (false_accepts + wrong) / (n_i + n_g) if impostor else wrong / n_g
        points.append(Point(round(float(t), 3), far, rejected / n_g, wrong / n_g))
    return points


def recommend(points: list, max_far: float = 0.001):
    """Lowest-FRR threshold with FAR <= max_far; falls back to the lowest-FAR point (and says so)."""
    ok = [p for p in points if p.far <= max_far]
    if ok:
        best = min(ok, key=lambda p: (p.frr, -p.threshold))
        return best, True
    return min(points, key=lambda p: (p.far, p.frr)), False
