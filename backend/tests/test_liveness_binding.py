"""
Liveness must be bound to the identity it unlocks:

* EARs (blink samples) only come from the face track that produced the
  identity, so a blink cannot be borrowed from a second face shown in between.
* The burst's closed-eye frame is embedded and must still look like the
  matched person, otherwise the burst's EARs are dropped.
* Passive anti-spoof keeps the most suspicious score over several frames.
* The pkg_resources fallback only installs itself when the real one is missing.
"""
import importlib
import os
import sys
import unittest
from unittest import mock

from app.services import face_service
from app.services.face_service import _box_iou, _same_track, recognize_burst
from app.vision import _pkg_resources_compat as compat
from app.vision.engines import Face
from app.vision.liveness import blink_candidate, evaluate_blink

from test_recognition_routes import BaseAppTest, jpeg

OPEN = (0.30, 0.30)
CLOSED = (0.15, 0.15)
BOX_A = (20, 140, 140, 20)     # (top, right, bottom, left)
BOX_B = (100, 310, 230, 190)   # elsewhere in the frame: no overlap with BOX_A


def _gray(i: int) -> int:
    return 20 + 20 * i


def _frames(n: int) -> list[bytes]:
    # Each frame gets its own flat grey level so fakes can tell frames apart.
    return [jpeg((_gray(i),) * 3).getvalue() for i in range(n)]


def _frame_index(image) -> int:
    return int(round((float(image.mean()) - 20) / 20))


class BurstHarness(BaseAppTest):
    """Fakes detection, quality, EAR and embedding per frame index."""

    def run_burst(self, boxes, ears, qualities, identity_of, spoof=None, **config):
        self.app.config.update(config)
        n = len(boxes)
        detect_calls = iter(range(n))

        def detect(image, width):
            i = _frame_index(image)
            next(detect_calls)
            return [Face(box=boxes[i], score=0.99)]

        def quality(image, box, **_):
            q = qualities[_frame_index(image)]
            return {"ok": q is not None, "score": q or 0.0, "reason": None if q is not None else "Too blurry."}

        def ear(gray, rect, source=None):
            return ears[_frame_index(gray)]

        def embed(image, face, num_jitters=1):
            return identity_of(_frame_index(image))

        patches = [
            mock.patch.object(self.engine, "track", return_value=None),
            mock.patch.object(self.engine, "detect", side_effect=detect),
            mock.patch.object(self.engine, "embed", side_effect=embed),
            mock.patch("app.services.face_service.assess_quality", side_effect=quality),
            mock.patch("app.services.face_service.frame_ear", side_effect=ear),
            mock.patch("app.services.face_service.enhance_for_embedding", side_effect=lambda img, box, clahe: img),
        ]
        if spoof is not None:
            patches.append(mock.patch("app.services.face_service.get_antispoof", return_value=spoof))
        for p in patches:
            p.start()
        try:
            result = recognize_burst(_frames(n))
            self.embed_calls = self.engine.embed.call_args_list
        finally:
            for p in reversed(patches):
                p.stop()
        return result


class TrackContinuityTests(BurstHarness):
    def test_ears_only_come_from_the_identity_track(self):
        # Frames 0-3: sharp photo of the employee at BOX_A (no blink).
        # Frames 4-7: a different face at BOX_B that blinks.
        boxes = [BOX_A] * 4 + [BOX_B] * 4
        ears = [OPEN] * 4 + [OPEN, CLOSED, OPEN, OPEN]
        qualities = [0.9] * 4 + [0.5] * 4
        result = self.run_burst(boxes, ears, qualities,
                                lambda i: self.face_a if i < 4 else self.face_b)
        self.assertEqual(result["status"], "MATCHED")
        self.assertEqual(result["user_id"], self.staff_id)
        self.assertEqual(result["ears"], [OPEN] * 4)
        self.assertEqual(result["frames_with_face"], 8)
        self.assertEqual(result["frames_discarded_other_tracks"], 4)
        self.assertFalse(evaluate_blink(result["ears"], 0.06)["passed"])
        # Nothing from the other track was embedded.
        self.assertTrue(all(_frame_index(c.args[0]) < 4 for c in self.embed_calls))

    def test_alternating_faces_never_pool_the_other_faces_blink(self):
        # Photo (A, sharp) and attacker (B, blinking) alternate every frame.
        boxes = [BOX_A, BOX_B] * 4
        ears = [OPEN, CLOSED] * 4
        qualities = [0.9, 0.5] * 4
        result = self.run_burst(boxes, ears, qualities,
                                lambda i: self.face_a if i % 2 == 0 else self.face_b)
        self.assertNotIn(CLOSED, result.get("ears", []))
        self.assertLessEqual(len(result.get("ears", [])), 1)

    def test_one_continuous_track_keeps_every_sample(self):
        boxes = [BOX_A] * 6
        ears = [OPEN, OPEN, CLOSED, OPEN, OPEN, OPEN]
        result = self.run_burst(boxes, ears, [0.9, 0.8, 0.5, 0.7, 0.6, 0.6], lambda i: self.face_a)
        self.assertEqual(result["status"], "MATCHED")
        self.assertEqual(result["ears"], ears)
        self.assertEqual(result["frames_discarded_other_tracks"], 0)

    def test_track_helpers(self):
        self.assertAlmostEqual(_box_iou(BOX_A, BOX_A), 1.0)
        self.assertEqual(_box_iou(BOX_A, BOX_B), 0.0)
        self.assertTrue(_same_track(BOX_A, (24, 144, 144, 24), 0.3))
        self.assertFalse(_same_track(BOX_A, BOX_B, 0.3))
        self.assertFalse(_same_track(None, BOX_A, 0.3))
        # Same centre, but the face suddenly doubles in size: a different face.
        self.assertFalse(_same_track((40, 120, 120, 40), (0, 160, 160, 0), 0.2))


class BlinkFrameIdentityTests(BurstHarness):
    BOXES = [BOX_A] * 6
    EARS = [OPEN, OPEN, CLOSED, OPEN, OPEN, OPEN]
    # The closed-eye frame (2) is never among the best identity frames.
    QUALITIES = [0.9, 0.85, 0.4, 0.5, 0.45, 0.45]

    def test_closed_eye_frame_of_someone_else_drops_the_ears(self):
        result = self.run_burst(self.BOXES, self.EARS, self.QUALITIES,
                                lambda i: self.face_b if i == 2 else self.face_a)
        self.assertEqual(result["status"], "MATCHED")
        self.assertEqual(result["user_id"], self.staff_id)
        self.assertTrue(result["liveness_identity_mismatch"])
        self.assertEqual(result["ears"], [])
        self.assertFalse(evaluate_blink(result["ears"], 0.06)["passed"])

    def test_closed_eye_frame_of_the_same_person_passes(self):
        result = self.run_burst(self.BOXES, self.EARS, self.QUALITIES, lambda i: self.face_a)
        self.assertEqual(result["status"], "MATCHED")
        self.assertFalse(result["liveness_identity_mismatch"])
        self.assertEqual(result["ears"], self.EARS)
        self.assertTrue(evaluate_blink(result["ears"], 0.06)["passed"])
        embedded = sorted(_frame_index(c.args[0]) for c in self.embed_calls)
        self.assertIn(2, embedded)  # the closed-eye frame was checked
        # Two identity frames + closed-eye frame + one open neighbour, at most.
        self.assertLessEqual(result["embeddings_computed"], 4)
        self.assertEqual(result["embeddings_computed"], len(self.embed_calls))

    def test_adjacent_open_eye_frame_of_someone_else_drops_the_ears(self):
        result = self.run_burst(self.BOXES, self.EARS, self.QUALITIES,
                                lambda i: self.face_b if i == 3 else self.face_a)
        self.assertTrue(result["liveness_identity_mismatch"])
        self.assertEqual(result["ears"], [])

    def test_check_can_be_disabled(self):
        result = self.run_burst(self.BOXES, self.EARS, self.QUALITIES,
                                lambda i: self.face_b if i == 2 else self.face_a,
                                LIVENESS_VERIFY_BLINK_FRAME=False)
        self.assertFalse(result["liveness_identity_mismatch"])
        self.assertEqual(result["ears"], self.EARS)

    def test_no_blink_candidate_costs_no_extra_embeddings(self):
        result = self.run_burst(self.BOXES, [OPEN] * 6, self.QUALITIES, lambda i: self.face_a)
        self.assertEqual(result["embeddings_computed"], 2)
        self.assertFalse(result["liveness_identity_mismatch"])

    def test_typical_ten_frame_burst_stays_cheap(self):
        ears = [OPEN] * 4 + [CLOSED] + [OPEN] * 5
        result = self.run_burst([BOX_A] * 10, ears, [0.9 - i * 0.05 for i in range(10)], lambda i: self.face_a)
        self.assertLessEqual(len(self.embed_calls), 5)
        self.assertEqual(result["status"], "MATCHED")

    def test_blink_candidate_needs_a_clear_drop(self):
        self.assertIsNone(blink_candidate([OPEN, OPEN, (0.29, 0.29)], 0.06))
        self.assertEqual(blink_candidate([OPEN, CLOSED, OPEN], 0.06), 1)
        self.assertIsNone(blink_candidate([OPEN], 0.06))


class MultiFrameSpoofTests(BurstHarness):
    def _spoof(self, scores):
        spoof = mock.Mock()
        spoof.has_model = True
        spoof.score.side_effect = [{"score": s, "method": "model"} for s in scores]
        return spoof

    def test_most_suspicious_embedded_frame_wins(self):
        spoof = self._spoof([0.95, 0.2])
        result = self.run_burst([BOX_A] * 4, [None] * 4, [0.9, 0.8, 0.7, 0.6], lambda i: self.face_a,
                                spoof=spoof, SPOOF_MODE="enforce", SPOOF_THRESHOLD=0.5)
        self.assertEqual(spoof.score.call_count, 2)
        self.assertEqual(result["spoof_score"], 0.2)
        self.assertTrue(result["spoof_suspected"])

    def test_all_real_frames_pass(self):
        spoof = self._spoof([0.95, 0.9])
        result = self.run_burst([BOX_A] * 4, [None] * 4, [0.9, 0.8, 0.7, 0.6], lambda i: self.face_a,
                                spoof=spoof, SPOOF_MODE="enforce", SPOOF_THRESHOLD=0.5)
        self.assertEqual(result["spoof_score"], 0.9)
        self.assertFalse(result["spoof_suspected"])

    def test_frame_count_is_configurable(self):
        spoof = self._spoof([0.95, 0.9])
        self.run_burst([BOX_A] * 4, [None] * 4, [0.9, 0.8, 0.7, 0.6], lambda i: self.face_a,
                       spoof=spoof, SPOOF_MODE="enforce", SPOOF_THRESHOLD=0.5, SPOOF_CHECK_FRAMES=1)
        self.assertEqual(spoof.score.call_count, 1)


class PkgResourcesCompatTests(unittest.TestCase):
    def test_no_top_level_shadow_module(self):
        backend = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.assertFalse(os.path.exists(os.path.join(backend, "pkg_resources.py")))
        real = sys.modules.get("pkg_resources")
        real_file = getattr(real, "__file__", None) if real is not None else None
        if real_file:  # the compat shim has no __file__
            self.assertNotEqual(os.path.dirname(os.path.abspath(real_file)), backend)

    def test_installs_only_when_the_real_module_is_missing(self):
        saved = sys.modules.get("pkg_resources", ...)
        try:
            sys.modules["pkg_resources"] = None  # makes `import pkg_resources` raise ImportError
            self.assertTrue(compat.install())
            shim = sys.modules["pkg_resources"]
            self.assertTrue(getattr(shim, compat.COMPAT_MARKER))
            path = shim.resource_filename("app.vision", "models/x.dat")
            self.assertEqual(path, os.path.join(os.path.dirname(compat.__file__), "models", "x.dat"))
            # Once something importable is registered, install() leaves it alone.
            self.assertFalse(compat.install())
        finally:
            if saved is ...:
                sys.modules.pop("pkg_resources", None)
            else:
                sys.modules["pkg_resources"] = saved

    def test_face_recognition_models_resolve(self):
        models = importlib.import_module("face_recognition_models")
        self.assertTrue(os.path.exists(models.pose_predictor_model_location()))


if __name__ == "__main__":
    unittest.main()
