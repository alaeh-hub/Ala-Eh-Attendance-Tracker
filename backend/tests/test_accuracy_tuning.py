import threading
import unittest
from unittest import mock

import cv2
import numpy as np

from app.services.face_service import recognize_burst
from app.vision.engines import DlibEngine, Face, SFaceEngine
from app.vision.quality import BLUR_THRESHOLD, assess_quality

from test_recognition_routes import BaseAppTest, jpeg, unit


def _soft_face(low=BLUR_THRESHOLD + 5, high=45 - 5):
    """A textured image blurred until its Laplacian variance sits between the kiosk
    and enrollment sharpness floors."""
    rng = np.random.default_rng(3)
    base = rng.integers(60, 200, size=(200, 200, 3), dtype=np.uint8)
    for sigma in np.arange(0.5, 6.0, 0.1):
        img = cv2.GaussianBlur(base, (0, 0), float(sigma))
        variance = cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
        if low <= variance <= high:
            return img
    raise AssertionError("could not build a mid-sharpness image")


class EngineDefaultsTests(unittest.TestCase):
    def test_sface_threshold_raised_after_full_lfw_evaluation(self):
        # 0.45 let 0.92% of strangers through on 588-person LFW; 0.50 is ~0.2%.
        self.assertEqual(SFaceEngine.DEFAULTS["FACE_MATCH_THRESHOLD"], 0.50)

    def test_kiosk_mirrors_for_sface_only(self):
        self.assertEqual(SFaceEngine.DEFAULTS["KIOSK_JITTERS"], 2)
        self.assertEqual(DlibEngine.DEFAULTS["KIOSK_JITTERS"], 1)  # random re-crops are too slow per frame


class SFaceMirrorTests(unittest.TestCase):
    def _engine(self):
        engine = SFaceEngine.__new__(SFaceEngine)
        engine._lock = threading.Lock()
        engine._recognizer = mock.Mock()
        engine._recognizer.alignCrop.side_effect = lambda image, raw: image
        # Vector depends on which half of the crop is brighter, so mirroring changes it.
        engine._recognizer.feature.side_effect = lambda img: np.array(
            [[float(img[:, :4].mean()) + 1.0, float(img[:, 4:].mean()) + 1.0]])
        return engine

    def _face_image(self):
        img = np.zeros((8, 8, 3), dtype=np.uint8)
        img[:, :4] = 200
        return img

    def test_two_jitters_embeds_original_and_mirror_and_averages(self):
        engine = self._engine()
        face = Face(box=(0, 8, 8, 0), score=1.0, raw=np.zeros(15))
        mirrored = engine.embed(self._face_image(), face, num_jitters=2)
        self.assertEqual(engine._recognizer.feature.call_count, 2)
        # Original leans one way, its mirror the other; the average is symmetric.
        self.assertAlmostEqual(float(mirrored[0]), float(mirrored[1]), places=4)

    def test_one_jitter_is_a_single_embedding(self):
        engine = self._engine()
        face = Face(box=(0, 8, 8, 0), score=1.0, raw=np.zeros(15))
        single = engine.embed(self._face_image(), face, num_jitters=1)
        self.assertEqual(engine._recognizer.feature.call_count, 1)
        self.assertNotAlmostEqual(float(single[0]), float(single[1]), places=2)


class EnrollmentBlurFloorTests(BaseAppTest):
    def test_enrollment_floor_is_stricter_than_the_kiosk_floor(self):
        self.assertGreater(self.app.config["ENROLL_BLUR_THRESHOLD"], BLUR_THRESHOLD)

    def test_mid_sharpness_face_passes_kiosk_but_not_enrollment(self):
        img = _soft_face()
        box = (0, 200, 200, 0)
        self.assertTrue(assess_quality(img, box)["ok"])
        rejected = assess_quality(img, box, min_blur=self.app.config["ENROLL_BLUR_THRESHOLD"])
        self.assertFalse(rejected["ok"])
        self.assertIn("blurry", rejected["reason"])

    def test_enrollment_and_ready_preview_both_use_the_floor(self):
        floor = self.app.config["ENROLL_BLUR_THRESHOLD"]
        ok = {"ok": True, "score": 0.9, "reason": None}
        with mock.patch.object(self.engine, "detect", return_value=[Face(box=(20, 220, 220, 20), score=0.99)]), \
                mock.patch.object(self.engine, "embed", return_value=self.face_a), \
                mock.patch("app.services.face_service.assess_quality", return_value=ok) as quality:
            res = self.client.post("/api/enrollment/sample", headers=self.auth(),
                                   data={"image": (jpeg(), "a.jpg"), "target_user_id": self.staff_id, "pose": "left"},
                                   content_type="multipart/form-data")
            self.assertEqual(res.status_code, 201, res.json)
            self.assertEqual(quality.call_args.kwargs["min_blur"], floor)

            from app.services.face_service import assess_capture_readiness
            assess_capture_readiness(jpeg().getvalue(), "frontal")
            self.assertEqual(quality.call_args.kwargs["min_blur"], floor)


class KioskMirrorTests(BaseAppTest):
    def test_recognize_burst_embeds_with_the_engine_kiosk_jitters(self):
        ok = {"ok": True, "score": 0.9, "reason": None}
        with mock.patch.object(self.engine, "detect", return_value=[Face(box=(20, 220, 220, 20), score=0.99)]), \
                mock.patch.object(self.engine, "embed", return_value=self.face_a) as embed, \
                mock.patch("app.services.face_service.assess_quality", return_value=ok), \
                mock.patch("app.services.face_service.frame_ear", return_value=None):
            result = recognize_burst([jpeg().getvalue(), jpeg().getvalue()])
        self.assertEqual(result["status"], "MATCHED")
        self.assertTrue(embed.called)
        for call in embed.call_args_list:
            self.assertEqual(call.kwargs["num_jitters"], self.engine.DEFAULTS["KIOSK_JITTERS"])


if __name__ == "__main__":
    unittest.main()
