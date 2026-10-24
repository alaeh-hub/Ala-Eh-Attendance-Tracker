"""The development-only detection details behind the frontend's debug overlay."""
import json
import os
import sys
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.vision.engines import Face  # noqa: E402
from test_recognition_routes import BaseAppTest, jpeg  # noqa: E402

# Test frames are 320 x 240. Boxes are (top, right, bottom, left).
IN_CIRCLE = (20, 220, 220, 20)
PASSER_BY = (10, 315, 60, 265)
ZONE = {"cx": 0.375, "cy": 0.5, "rx": 0.25, "ry": 0.45}
LANDMARKS = np.array([[80, 90], [160, 90], [120, 130], [90, 170], [150, 170]], dtype=np.float32)  # np.float32 on purpose
GOOD_QUALITY = {"ok": True, "score": 0.9, "reason": None}


def face(box, landmarks=LANDMARKS):
    return Face(box=box, score=0.987, landmarks=landmarks)


class EnrollmentCheckDebugTests(BaseAppTest):
    def _check(self, faces, debug=True, zone=ZONE):
        data = {"image": (jpeg(), "a.jpg"), "pose": "frontal"}
        if zone:
            data["zone"] = json.dumps(zone)
        if debug:
            data["debug"] = "1"
        with mock.patch.object(self.engine, "detect", return_value=faces), \
                mock.patch("app.services.face_service.assess_quality", return_value=GOOD_QUALITY):
            return self.client.post("/api/enrollment/check", headers=self.auth(), data=data, content_type="multipart/form-data")

    def test_describes_what_the_detector_saw(self):
        res = self._check([face(IN_CIRCLE)])
        self.assertEqual(res.status_code, 200)
        d = res.json["debug"]
        self.assertEqual(d["image"], {"w": 320, "h": 240})
        [seen] = d["faces"]
        self.assertEqual(seen["box"], [20, 20, 220, 220])  # [left, top, right, bottom]
        self.assertTrue(seen["chosen"])
        self.assertEqual(seen["score"], 0.987)
        self.assertEqual(seen["landmarks"][2], [120.0, 130.0])  # nose
        self.assertEqual(len(seen["landmarks"]), 5)

    def test_includes_the_guide_oval_and_the_numbers_behind_ready(self):
        d = self._check([face(IN_CIRCLE)]).json["debug"]
        self.assertEqual(d["zone"]["cx"], ZONE["cx"])
        self.assertEqual(d["zone"]["margin"], 1.3)
        self.assertEqual(d["quality"], {"ok": True, "score": 0.9, "reason": None})
        self.assertEqual(d["pose"]["label"], "frontal")
        self.assertIn("yaw", d["pose"])
        self.assertIn("progress", d["pose"])

    def test_without_a_zone_the_oval_is_null(self):
        self.assertIsNone(self._check([face(IN_CIRCLE)], zone=None).json["debug"]["zone"])

    def test_shows_a_face_that_was_seen_but_not_used(self):
        res = self._check([face(PASSER_BY)])
        self.assertFalse(res.json["ready"])
        self.assertIn("circle", res.json["reason"])
        [seen] = res.json["debug"]["faces"]
        self.assertFalse(seen["chosen"])  # detected, but outside the circle

    def test_marks_which_of_several_faces_was_used(self):
        d = self._check([face(IN_CIRCLE), face(PASSER_BY)]).json["debug"]
        self.assertEqual([f["chosen"] for f in d["faces"]], [True, False])

    def test_a_detector_without_landmarks_still_works(self):
        [seen] = self._check([Face(box=IN_CIRCLE, score=0.9, landmarks=None)], zone=None).json["debug"]["faces"]
        self.assertNotIn("landmarks", seen)

    def test_nothing_extra_unless_asked(self):
        self.assertNotIn("debug", self._check([face(IN_CIRCLE)], debug=False).json)

    def test_a_production_server_never_sends_it(self):
        self.app.config["APP_ENV"] = "production"
        res = self._check([face(IN_CIRCLE)])
        self.assertEqual(res.status_code, 200)
        self.assertNotIn("debug", res.json)
        self.assertNotIn("landmarks", json.dumps(res.json))


class CheckInDebugTests(BaseAppTest):
    def _check_in(self, faces, debug=True, zone=ZONE):
        data = {"frames": [(jpeg(), "f0.jpg"), (jpeg(), "f1.jpg")], "device_id": "kiosk-1"}
        if zone:
            data["zone"] = json.dumps(zone)
        if debug:
            data["debug"] = "1"
        with mock.patch.object(self.engine, "detect", return_value=faces):
            return self.client.post("/api/recognition/check-in", headers=self.kiosk_auth(), data=data, content_type="multipart/form-data")

    def test_reports_the_face_outside_the_circle_and_the_match_settings(self):
        res = self._check_in([face(PASSER_BY)])
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json["status"], "NO_FACE")
        d = res.json["debug"]
        self.assertEqual(d["image"], {"w": 320, "h": 240})
        self.assertEqual(d["status"], "NO_FACE")
        self.assertEqual(d["threshold"], round(float(self.app.config.get("FACE_MATCH_THRESHOLD") or self.engine.DEFAULTS["FACE_MATCH_THRESHOLD"]), 4))
        self.assertEqual(d["frames"], 2)
        [seen] = d["faces"]
        self.assertFalse(seen["chosen"])
        self.assertEqual(len(seen["landmarks"]), 5)
        self.assertEqual(d["zone"]["rx"], ZONE["rx"])

    def test_nothing_extra_unless_asked(self):
        self.assertNotIn("debug", self._check_in([face(PASSER_BY)], debug=False).json)

    def test_a_production_server_never_sends_it(self):
        self.app.config["APP_ENV"] = "production"
        res = self._check_in([face(PASSER_BY)])
        self.assertEqual(res.status_code, 200)
        self.assertNotIn("debug", res.json)

    def test_every_kind_of_answer_carries_it(self):
        # The debug data rides on the shared response metadata, so it is on non-NO_FACE answers too.
        # "score" is a plain float (the route returns it as it is); the fields only the debug data reads are numpy floats.
        burst = {"status": "LOW_CONFIDENCE", "reason": "Hold still.", "score": 0.41, "runner_up_score": np.float32(0.3),
                 "ears": [], "frames_with_face": 2, "elapsed_ms": 5, "vote_ratio": np.float32(0.5), "engine": "sface"}
        with mock.patch("app.api.recognition_routes.recognize_burst", return_value=burst) as scan:
            res = self.client.post("/api/recognition/check-in", headers=self.kiosk_auth(), content_type="multipart/form-data",
                                   data={"frames": [(jpeg(), "f.jpg")], "debug": "1"})
        self.assertEqual(res.status_code, 200)  # numpy floats in the result did not break the JSON
        self.assertEqual(res.json["debug"]["score"], 0.41)
        self.assertEqual(res.json["debug"]["runner_up"], 0.3)
        self.assertEqual(res.json["debug"]["vote_ratio"], 0.5)
        self.assertEqual(res.json["debug"]["engine"], "sface")
        self.assertIsInstance(scan.call_args.args[2], dict)  # the route hands the scanner a dict to fill

    def test_no_dict_is_handed_over_when_not_asked(self):
        burst = {"status": "NO_FACE", "reason": "x", "ears": [], "frames_with_face": 0, "elapsed_ms": 1}
        with mock.patch("app.api.recognition_routes.recognize_burst", return_value=burst) as scan:
            self.client.post("/api/recognition/check-in", headers=self.kiosk_auth(), content_type="multipart/form-data",
                             data={"frames": [(jpeg(), "f.jpg")]})
        self.assertIsNone(scan.call_args.args[2])


class LiveDetectTests(BaseAppTest):
    """The kiosk's live preview: what the detector sees in one frame, with no scan running."""

    TINY = (100, 150, 140, 110)  # inside the circle but far too small
    TWIN_A, TWIN_B = (20, 120, 120, 20), (20, 300, 120, 200)  # two equally large faces

    def _detect(self, faces, zone=ZONE, frame=True, headers=None):
        data = {}
        if frame:
            data["frame"] = (jpeg(), "live.jpg")
        if zone:
            data["zone"] = json.dumps(zone)
        with mock.patch.object(self.engine, "detect", return_value=faces), mock.patch.object(self.engine, "embed") as embed:
            res = self.client.post("/api/recognition/debug-detect", headers=headers or self.kiosk_auth(), data=data, content_type="multipart/form-data")
            embed.assert_not_called()  # nobody is identified
        return res

    def test_a_face_in_the_circle_is_the_one_a_scan_would_use(self):
        res = self._detect([face(IN_CIRCLE)])
        self.assertEqual(res.status_code, 200)
        d = res.json["debug"]
        self.assertTrue(d["live"])
        self.assertIsNone(d["reason"])
        self.assertEqual(d["image"], {"w": 320, "h": 240})
        self.assertIsInstance(d["ms"], int)
        self.assertEqual(d["engine"], self.engine.name)
        [seen] = d["faces"]
        self.assertTrue(seen["chosen"])
        self.assertEqual(len(seen["landmarks"]), 5)
        self.assertEqual(d["zone"]["rx"], ZONE["rx"])

    def test_a_face_outside_the_circle_is_seen_but_not_used(self):
        d = self._detect([face(PASSER_BY)]).json["debug"]
        self.assertIn("circle", d["reason"])
        self.assertEqual([f["chosen"] for f in d["faces"]], [False])

    def test_a_face_that_is_too_small_is_asked_to_come_closer(self):
        d = self._detect([face(self.TINY)]).json["debug"]
        self.assertIn("closer", d["reason"])
        self.assertEqual([f["chosen"] for f in d["faces"]], [False])

    def test_an_empty_frame_says_so(self):
        d = self._detect([]).json["debug"]
        self.assertEqual(d["faces"], [])
        self.assertIn("No face", d["reason"])

    def test_two_equal_faces_are_refused_but_a_clearly_closer_one_wins(self):
        twins = self._detect([face(self.TWIN_A), face(self.TWIN_B)], zone=None).json["debug"]
        self.assertIn("Multiple", twins["reason"])
        self.assertEqual([f["chosen"] for f in twins["faces"]], [False, False])

        dominant = self._detect([face(IN_CIRCLE), face(PASSER_BY)], zone=None).json["debug"]
        self.assertIsNone(dominant["reason"])
        self.assertEqual([f["chosen"] for f in dominant["faces"]], [True, False])

    def test_without_a_zone_any_face_counts(self):
        d = self._detect([face(self.TINY)], zone=None).json["debug"]
        self.assertIsNone(d["reason"])
        self.assertIsNone(d["zone"])

    def test_works_for_a_kiosk_session_and_for_an_admin(self):
        self.assertEqual(self._detect([face(IN_CIRCLE)], headers=self.kiosk_auth()).status_code, 200)
        self.assertEqual(self._detect([face(IN_CIRCLE)], headers=self.auth()).status_code, 200)

    def test_a_production_server_answers_as_if_it_did_not_exist(self):
        self.app.config["APP_ENV"] = "production"
        res = self._detect([face(IN_CIRCLE)])
        self.assertEqual(res.status_code, 404)
        self.assertNotIn("debug", res.json)
        self.assertNotIn("landmarks", json.dumps(res.json))

    def test_a_frame_and_a_login_are_required(self):
        self.assertEqual(self._detect([], frame=False).status_code, 400)
        from flask import g
        g.pop("current_user", None)
        res = self.client.post("/api/recognition/debug-detect", data={}, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 401)

    def test_does_not_store_anything(self):
        from app.models.scan_snapshot import ScanSnapshot
        self._detect([face(IN_CIRCLE)])
        self.assertEqual(ScanSnapshot.query.count(), 0)

if __name__ == "__main__":
    unittest.main()
