"""Chin-up / chin-down enrollment poses measured from the chin (dlib 68-point jaw), and the jaw in the debug data."""
import json
import os
import sys
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.vision.engines import Face  # noqa: E402
from app.vision.pose import CHIN_SPAN_RATIO, assess_pose  # noqa: E402
from test_debug_overlay import GOOD_QUALITY, IN_CIRCLE, LANDMARKS, ZONE, face  # noqa: E402
from test_recognition_routes import BaseAppTest, jpeg  # noqa: E402

IMAGE = np.zeros((240, 320, 3), dtype=np.uint8)
FACE = Face(box=IN_CIRCLE, score=0.99, landmarks=LANDMARKS)


def jaw(nose_y: float, eye_y: float = 90.0, chin_y: float = 210.0) -> dict:
    """A fitted jaw: the nose tip at `nose_y`, eyes at `eye_y`, chin at `chin_y` (pixels)."""
    ear_to_ear = np.array([[60 + 5 * i, 130 + 5 * i] for i in range(17)], dtype=np.float32)
    return {"jaw": ear_to_ear, "chin": np.array([120.0, chin_y], dtype=np.float32),
            "nose_tip": np.array([120.0, nose_y], dtype=np.float32), "eye_mid": np.array([120.0, eye_y], dtype=np.float32),
            "forehead": np.array([120.0, 40.0], dtype=np.float32)}


def pose(label, nose_y, **kw):
    with mock.patch("app.vision.liveness.jaw_landmarks", return_value=jaw(nose_y)):
        return assess_pose(FACE, label, image=IMAGE, **kw)


class ChinPitchTests(unittest.TestCase):
    def test_pitch_is_the_noses_place_between_the_eyes_and_the_chin(self):
        self.assertAlmostEqual(pose("frontal", nose_y=150)["pitch"], 0.5, places=3)  # halfway down the face

    def test_chin_up_is_accepted_once_the_nose_has_moved_far_enough(self):
        base = (0.0, 0.5)
        self.assertFalse(pose("up", 150 + 120 * 0.01, baseline=base)["ok"])  # barely moved
        self.assertTrue(pose("up", 150 + 120 * 0.06, baseline=base)["ok"])   # clearly tilted

    def test_chin_down_must_go_the_opposite_way_from_chin_up(self):
        base = (0.0, 0.5)
        up_deviation = 0.06  # chin-up moved the nose fraction by +0.06
        went_down = pose("down", 150 - 120 * 0.06, baseline=base, reference=up_deviation)
        went_up_again = pose("down", 150 + 120 * 0.06, baseline=base, reference=up_deviation)
        self.assertTrue(went_down["ok"])
        self.assertFalse(went_up_again["ok"])

    def test_thresholds_follow_the_chin_scale(self):
        # 0.07 in interocular units == 0.07 / CHIN_SPAN_RATIO of the eye-to-chin span.
        edge = 0.07 / CHIN_SPAN_RATIO
        self.assertFalse(pose("up", 150 + 120 * (edge * 0.9), baseline=(0.0, 0.5))["ok"])
        self.assertTrue(pose("up", 150 + 120 * (edge * 1.1), baseline=(0.0, 0.5))["ok"])

    def test_no_chin_means_not_ready_rather_than_mixing_measurements(self):
        with mock.patch("app.vision.liveness.jaw_landmarks", return_value=None):
            res = assess_pose(FACE, "up", baseline=(0.0, 0.5), image=IMAGE)
        self.assertFalse(res["ok"])
        self.assertIn("chin", res["reason"])
        self.assertIsNone(res["pitch"])

    def test_without_an_image_the_old_five_point_pitch_is_used(self):
        res = assess_pose(FACE, "frontal")
        self.assertIsNone(res["jaw"])
        self.assertAlmostEqual(res["pitch"], (130 - 90) / 80, places=3)


class ForeheadEstimateTests(unittest.TestCase):
    def test_forehead_is_estimated_above_the_brows_along_the_brow_chin_line(self):
        from app.vision.liveness import jaw_landmarks

        pts = np.zeros((68, 2), dtype=np.float32)
        pts[7:10] = [120, 210]            # chin
        pts[19] = pts[24] = [120, 90]     # brows
        pts[36:48] = [120, 100]           # eyes
        crop = (np.zeros((10, 10, 3), dtype=np.uint8), None, 0, 0, 1.0)  # identity crop: points stay in image pixels
        with mock.patch("app.vision.liveness._landmark_crop", return_value=crop), \
                mock.patch("app.vision.liveness.get_eye_landmark_source") as src:
            src.return_value.face_landmarks.return_value = pts
            out = jaw_landmarks(np.zeros((240, 320, 3), dtype=np.uint8), FACE.landmark_rect())
        # brow-to-chin is 120px, so the hairline sits 60px above the brows
        self.assertTrue(np.allclose(out["forehead"], [120, 30], atol=1.5))


class JawDebugTests(BaseAppTest):
    def test_enrollment_check_returns_the_chin_and_jaw_for_the_chosen_face(self):
        data = {"image": (jpeg(), "a.jpg"), "pose": "frontal", "zone": json.dumps(ZONE), "debug": "1"}
        with mock.patch.object(self.engine, "detect", return_value=[face(IN_CIRCLE)]), \
                mock.patch("app.services.face_service.assess_quality", return_value=GOOD_QUALITY), \
                mock.patch("app.vision.liveness.jaw_landmarks", return_value=jaw(150)):
            res = self.client.post("/api/enrollment/check", headers=self.auth(), data=data, content_type="multipart/form-data")
        [seen] = res.json["debug"]["faces"]
        self.assertEqual(seen["chin"], [120.0, 210.0])
        self.assertEqual(len(seen["jaw"]), 17)
        self.assertEqual(seen["forehead"], [120.0, 40.0])
        self.assertIsInstance(res.json["pitch"], float)


if __name__ == "__main__":
    unittest.main()
