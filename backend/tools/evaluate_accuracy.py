"""
Measure recognition accuracy on YOUR cameras and pick the match threshold
from data instead of guessing.

Folder layout:

    dataset/
      alice/   1.jpg 2.jpg 3.jpg 4.jpg ...   (enrolled people, >= 3 photos each)
      bob/     ...
      _unknown/  x1.jpg x2.jpg ...           (people who are NOT enrolled)

For each person the first --enroll photos are the gallery and the rest are
genuine probes; _unknown photos are impostor probes. Use photos taken at the
kiosk (same camera, lighting, distance) for numbers that mean something.

    cd backend
    .venv\\Scripts\\python tools\\evaluate_accuracy.py path\\to\\dataset

Prints FAR / FRR per threshold and the recommended FACE_MATCH_THRESHOLD.
"""
import argparse
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.accuracy_eval import build_gallery, compute_curve, recommend  # noqa: E402
from app.vision.engines import get_engine, pick_single_face  # noqa: E402
from app.vision.enhance import enhance_for_embedding  # noqa: E402

EXTS = (".jpg", ".jpeg", ".png", ".bmp")


def embed_file(engine, path, jitters=1):
    image = cv2.imread(path)
    if image is None:
        return None
    face, err = pick_single_face(
        engine.detect(image, 480), allow_dominant=True)
    if err:
        print(f"  skip {os.path.basename(path)}: {err}")
        return None
    vec = engine.embed(enhance_for_embedding(
        image, face.box), face, num_jitters=jitters)
    return None if vec is None else np.asarray(vec, dtype=np.float32) / np.linalg.norm(vec)


def images_in(folder):
    return sorted(os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(EXTS))


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset")
    ap.add_argument("--engine", default="auto")
    ap.add_argument("--enroll", type=int, default=3,
                    help="photos per person used as enrollment samples")
    ap.add_argument("--margin", type=float, default=None,
                    help="ambiguity margin (default: engine default)")
    ap.add_argument("--max-far", type=float, default=0.001,
                    help="target false-accept rate")
    ap.add_argument("--probe-jitters", type=int, default=None,
                    help="variants averaged per probe photo (default: the engine's KIOSK_JITTERS; 1 = off)")
    args = ap.parse_args()

    engine = get_engine(args.engine)
    margin = args.margin if args.margin is not None else engine.DEFAULTS[
        "FACE_AMBIGUITY_MARGIN"]
    probe_jitters = args.probe_jitters if args.probe_jitters is not None else engine.DEFAULTS.get("KIOSK_JITTERS", 1)
    print(f"engine={engine.name} margin={margin} enroll_samples={args.enroll} probe_jitters={probe_jitters}")

    samples, genuine, impostors = {}, [], []
    for name in sorted(os.listdir(args.dataset)):
        folder = os.path.join(args.dataset, name)
        if not os.path.isdir(folder):
            continue
        if name == "_unknown":
            impostors = [v for v in (embed_file(engine, p, jitters=probe_jitters)
                                     for p in images_in(folder)) if v is not None]
            continue
        vecs = [(p, embed_file(engine, p, jitters=5 if i < args.enroll else probe_jitters))
                for i, p in enumerate(images_in(folder))]
        vecs = [v for _, v in vecs if v is not None]
        if len(vecs) <= args.enroll:
            print(f"  {name}: needs more than {args.enroll} usable photos, skipped")
            continue
        samples[name] = np.vstack(vecs[: args.enroll])
        genuine += [(name, v) for v in vecs[args.enroll:]]

    if len(samples) < 2 or not genuine:
        sys.exit("Need at least 2 people with more than --enroll usable photos each.")
    if not impostors:
        print(
            "WARNING: no _unknown photos - false accepts of strangers cannot be measured.")

    gallery = build_gallery(samples)
    points = compute_curve(gallery, genuine, impostors,
                           np.arange(0.25, 0.85, 0.02), margin)
    print(
        f"\npeople={len(samples)} genuine_probes={len(genuine)} impostor_probes={len(impostors)}\n")
    print(f"{'threshold':>9} {'FAR %':>8} {'FRR %':>8} {'wrong-person %':>15}")
    for p in points:
        print(
            f"{p.threshold:>9.2f} {p.far * 100:>8.2f} {p.frr * 100:>8.2f} {p.wrong_person * 100:>15.2f}")

    best, met_target = recommend(points, args.max_far)
    if met_target:
        print(
            f"\nRecommended FACE_MATCH_THRESHOLD={best.threshold} (FAR {best.far * 100:.2f}%, FRR {best.frr * 100:.2f}%)")
    else:
        print(f"\nNo threshold reached FAR <= {args.max_far * 100:.2f}%. Lowest FAR is at {best.threshold} "
              f"(FAR {best.far * 100:.2f}%, FRR {best.frr * 100:.2f}%). Add better photos or enroll more samples.")
    print(f"Current engine default: {engine.DEFAULTS['FACE_MATCH_THRESHOLD']}")


if __name__ == "__main__":
    main()
