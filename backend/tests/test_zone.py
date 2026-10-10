"""The kiosk guide oval: parsing, the in-circle test, and wiring into check-in."""
import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.vision.zone import GuideZone, faces_in_zone, inside_zone, parse_zone, too_small  # noqa: E402
from app.vision.engines import Face  # noqa: E402
from test_recognition_routes import BaseAppTest, jpeg  # noqa: E402

ZONE = GuideZone(cx=0.5, cy=0.5, rx=0.2, ry=0.4)  # 1000 x 1000 frame -> oval 400 wide, 800 tall


def box(cx, cy, size):
    """(top, right, bottom, left) of a square face centred at pixel (cx, cy)."""
    return (cy - size // 2, cx + size // 2, cy + size // 2, cx - size // 2)


class ParseTests(unittest.TestCase):
    def test_valid_zone(self):
        z = parse_zone(json.dumps({"cx": 0.5, "cy": 0.45, "rx": 0.2, "ry": 0.4}))
        self.assertEqual(z, GuideZone(0.5, 0.45, 0.2, 0.4))

    def test_missing_or_bad_input_means_no_zone(self):
        for raw in (None, "", "not json", "{}", json.dumps({"cx": "x", "cy": 0.5, "rx": 0.2, "ry": 0.4}),
                    json.dumps({"cx": 0.5, "cy": 0.5, "rx": 0, "ry": 0.4}),      # radius too small
                    json.dumps({"cx": 3, "cy": 0.5, "rx": 0.2, "ry": 0.4}),      # centre outside the frame
                    '{"cx": NaN, "cy": 0.5, "rx": 0.2, "ry": 0.4}'):
            self.assertIsNone(parse_zone(raw), raw)


class GeometryTests(unittest.TestCase):
    def test_centre_is_inside(self):
        self.assertTrue(inside_zone(ZONE, box(500, 500, 400), 1000, 1000))

    def test_slightly_off_centre_still_scans(self):
        self.assertTrue(inside_zone(ZONE, box(600, 500, 400), 1000, 1000))

    def test_far_to_the_side_is_outside(self):
        self.assertFalse(inside_zone(ZONE, box(120, 500, 300), 1000, 1000))

    def test_background_face_is_filtered_out(self):
        near = SimpleNamespace(box=box(500, 500, 450))
        passer_by = SimpleNamespace(box=box(900, 300, 150))
        self.assertEqual(faces_in_zone(ZONE, [near, passer_by], 1000, 1000), [near])

    def test_small_face_is_too_small(self):
        self.assertTrue(too_small(ZONE, box(500, 500, 200), 1000))    # 20% of frame height < 0.4 * 80%
        self.assertFalse(too_small(ZONE, box(500, 500, 450), 1000))


class CheckInWiringTests(BaseAppTest):
    def _post(self, zone=None):
        data = {"frames": [(jpeg(), "f0.jpg")], "device_id": "kiosk-1"}
        if zone is not None:
            data["zone"] = zone
        return self.client.post("/api/recognition/check-in", headers=self.auth(), data=data, content_type="multipart/form-data")

    def test_zone_is_passed_to_the_scanner(self):
        burst = {"status": "NO_FACE", "reason": "Move into the circle.", "ears": [], "frames_with_face": 0, "elapsed_ms": 1}
        with mock.patch("app.api.recognition_routes.recognize_burst", return_value=burst) as scan:
            res = self._post(json.dumps({"cx": 0.5, "cy": 0.45, "rx": 0.2, "ry": 0.4}))
        self.assertEqual(res.json["status"], "NO_FACE")
        self.assertEqual(scan.call_args.args[1], GuideZone(0.5, 0.45, 0.2, 0.4))

    def test_no_zone_means_no_restriction(self):
        burst = {"status": "NO_FACE", "reason": "x", "ears": [], "frames_with_face": 0, "elapsed_ms": 1}
        with mock.patch("app.api.recognition_routes.recognize_burst", return_value=burst) as scan:
            self._post()
            self._post("garbage")
        self.assertIsNone(scan.call_args_list[0].args[1])
        self.assertIsNone(scan.call_args_list[1].args[1])


class EnrollmentZoneTests(BaseAppTest):
    """Enrollment honours the guide oval too. Test frames are 320x240."""

    IN_CIRCLE = (20, 220, 220, 20)       # a big face left of centre
    PASSER_BY = (10, 315, 60, 265)       # a small face in the top-right corner
    TINY = (100, 150, 140, 110)          # inside the circle but far too small
    ZONE = json.dumps({"cx": 0.375, "cy": 0.5, "rx": 0.25, "ry": 0.45})

    def _sample(self, faces, zone=ZONE, pose="left"):
        from contextlib import ExitStack
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(self.engine, "detect", return_value=[Face(box=b, score=0.99) for b in faces]))
            stack.enter_context(mock.patch.object(self.engine, "embed", return_value=self.face_a))
            stack.enter_context(mock.patch("app.services.face_service.assess_quality", return_value={"ok": True, "score": 0.9, "reason": None}))
            data = {"image": (jpeg(), "a.jpg"), "target_user_id": self.staff_id, "pose": pose}
            if zone:
                data["zone"] = zone
            return self.client.post("/api/enrollment/sample", headers=self.auth(), data=data, content_type="multipart/form-data")

    def test_face_inside_the_circle_enrols(self):
        self.assertEqual(self._sample([self.IN_CIRCLE]).status_code, 201)

    def test_passer_by_outside_the_circle_is_ignored(self):
        # Without a zone two faces would block enrolment; with it the stranger is ignored.
        self.assertEqual(self._sample([self.IN_CIRCLE, self.PASSER_BY], zone=None).status_code, 422)
        self.assertEqual(self._sample([self.IN_CIRCLE, self.PASSER_BY]).status_code, 201)

    def test_face_outside_the_circle_is_refused(self):
        res = self._sample([self.PASSER_BY])
        self.assertEqual(res.status_code, 422)
        self.assertIn("circle", res.json["error"])

    def test_tiny_face_is_asked_to_come_closer(self):
        res = self._sample([self.TINY])
        self.assertEqual(res.status_code, 422)
        self.assertIn("closer", res.json["error"])

    def test_no_zone_keeps_the_old_behaviour(self):
        self.assertEqual(self._sample([self.TINY], zone=None).status_code, 201)

    def test_unknown_pose_is_rejected(self):
        res = self._sample([self.IN_CIRCLE], pose="sideways")
        self.assertEqual(res.status_code, 400)

    def test_live_check_tells_the_admin_to_move(self):
        from contextlib import ExitStack
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(self.engine, "detect", return_value=[Face(box=self.PASSER_BY, score=0.99)]))
            res = self.client.post("/api/enrollment/check", headers=self.auth(), content_type="multipart/form-data",
                                   data={"image": (jpeg(), "a.jpg"), "pose": "frontal", "zone": self.ZONE})
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.json["ready"])
        self.assertIn("circle", res.json["reason"])


class KioskConfigTests(BaseAppTest):
    def test_returns_org_time_and_the_lunch_break(self):
        res = self.client.get("/api/recognition/kiosk-config", headers=self.auth())
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json["break_start"], self.app.config["BREAK_START"])
        self.assertEqual(res.json["break_end"], self.app.config["BREAK_END"])
        self.assertTrue(0 <= res.json["local_minutes"] < 1440)

    def test_requires_a_signed_in_user(self):
        self.assertEqual(self.client.get("/api/recognition/kiosk-config").status_code, 401)


class PresenceTests(BaseAppTest):
    """The idle kiosk's "is someone there?" check. Test frames are 320x240."""

    IN_CIRCLE = (20, 220, 220, 20)
    PASSER_BY = (10, 315, 60, 265)
    TINY = (100, 150, 140, 110)
    ZONE = json.dumps({"cx": 0.375, "cy": 0.5, "rx": 0.25, "ry": 0.45})

    def _check(self, faces, zone=ZONE, frame=True):
        data = {}
        if frame:
            data["frame"] = (jpeg(), "p.jpg")
        if zone:
            data["zone"] = zone
        with mock.patch.object(self.engine, "detect", return_value=[Face(box=b, score=0.99) for b in faces]),                 mock.patch.object(self.engine, "embed") as embed:
            res = self.client.post("/api/recognition/presence", headers=self.auth(), data=data, content_type="multipart/form-data")
            embed.assert_not_called()          # detection only: nobody is identified
        return res

    def test_someone_in_the_circle_is_present(self):
        self.assertEqual(self._check([self.IN_CIRCLE]).json, {"present": True})

    def test_nobody_in_frame(self):
        self.assertEqual(self._check([]).json, {"present": False})

    def test_passer_by_outside_the_circle_does_not_count(self):
        self.assertEqual(self._check([self.PASSER_BY]).json, {"present": False})

    def test_someone_far_back_does_not_count(self):
        self.assertEqual(self._check([self.TINY]).json, {"present": False})

    def test_a_close_person_counts_even_with_a_passer_by(self):
        self.assertEqual(self._check([self.PASSER_BY, self.IN_CIRCLE]).json, {"present": True})

    def test_without_a_zone_any_face_counts(self):
        self.assertEqual(self._check([self.TINY], zone=None).json, {"present": True})

    def test_a_frame_is_required_and_login_too(self):
        self.assertEqual(self._check([], frame=False).status_code, 400)
        from flask import g
        g.pop("current_user", None)
        self.assertEqual(self.client.post("/api/recognition/presence", data={}, content_type="multipart/form-data").status_code, 401)

    def test_does_not_store_anything(self):
        from app.models.scan_snapshot import ScanSnapshot
        self._check([self.IN_CIRCLE])
        self.assertEqual(ScanSnapshot.query.count(), 0)


if __name__ == "__main__":
    unittest.main()
