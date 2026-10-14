"""
End-to-end flow through the real HTTP routes: sign in, create an employee,
enroll their face, clock in at the kiosk, see it in the reports, handle a
stranger, and wipe face data.

Only the camera-dependent leaves are faked: face detection, the embedding
network, image quality and blink landmarks. Everything else (auth, routing,
consent, enrollment checks, the embedding index, matching, multi-frame
voting, liveness pooling, attendance rules, snapshots, reports, CSV) is the
production code.
"""
import itertools
import unittest
from contextlib import ExitStack
from unittest import mock

import numpy as np
from flask import g

from app.extensions import db
from app.models.attendance_event import AttendanceEvent
from app.models.face_embedding import FaceEmbedding
from app.models.scan_snapshot import ScanSnapshot
from app.services import snapshot_service
from app.vision.engines import Face
from test_recognition_routes import BaseAppTest, jpeg, unit

# Left/right eye aspect ratios across a burst: eyes open, one clear blink, open again.
BLINK_BURST = [(0.31, 0.30), (0.30, 0.31), (0.14, 0.13), (0.30, 0.31), (0.31, 0.30), (0.30, 0.30), (0.31, 0.31), (0.30, 0.30)]


class EndToEndTests(BaseAppTest):
    def setUp(self):
        super().setUp()
        snapshot_service._throttle.clear()
        self.rng = np.random.default_rng(42)
        self.current_face = None   # the vector the fake network "sees"
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch.object(self.engine, "detect", side_effect=lambda *a, **k: [Face(box=(20, 220, 220, 20), score=0.99)]))
        stack.enter_context(mock.patch.object(self.engine, "track", return_value=None))
        stack.enter_context(mock.patch.object(self.engine, "embed", side_effect=lambda *a, **k: self.current_face))
        stack.enter_context(mock.patch("app.services.face_service.assess_quality", return_value={"ok": True, "score": 0.9, "reason": None}))
        stack.enter_context(mock.patch("app.services.face_service.frame_ear", side_effect=itertools.cycle(BLINK_BURST)))

    # -- helpers -----------------------------------------------------------
    def login_admin(self):
        res = self.client.post("/api/auth/login", json={"email": "admin@example.test", "password": "test-password"})
        self.assertEqual(res.status_code, 200, res.json)
        g.pop("current_user", None)
        return {"Authorization": f"Bearer {res.json['access_token']}"}

    def open_kiosk(self):
        """A separate browser (the tablet) signs in and locks itself to the kiosk."""
        login = self.login_admin()
        res = self.client.post("/api/auth/kiosk/lock", headers=login)
        self.assertEqual(res.status_code, 200, res.json)
        self.assertTrue(res.json["kiosk_locked"])
        return {"Authorization": f"Bearer {res.json['access_token']}"}

    def see_person(self, base, jitter=0.01):
        self.current_face = unit(base + self.rng.normal(scale=jitter, size=128))

    def enroll_pose(self, headers, user_id, pose, consent=False):
        data = {"image": (jpeg(), f"{pose}.jpg"), "target_user_id": user_id, "pose": pose}
        if consent:
            data["consent"] = "true"
        g.pop("current_user", None)
        return self.client.post("/api/enrollment/sample", headers=headers, data=data, content_type="multipart/form-data")

    def scan(self, headers, device="kiosk-1"):
        g.pop("current_user", None)
        return self.client.post("/api/recognition/check-in", headers=headers, content_type="multipart/form-data",
                                data={"frames": [(jpeg(), f"f{i}.jpg") for i in range(8)], "device_id": device})

    # -- the journey -------------------------------------------------------
    def test_full_attendance_journey(self):
        admin = self.login_admin()

        # 1. Admin creates an employee.
        res = self.client.post("/api/users", headers=admin, json={
            "full_name": "Maria Santos", "email": "maria@example.test", "department": "Production", "position": "Packer"})
        self.assertEqual(res.status_code, 201, res.json)
        maria = res.json
        self.assertFalse(maria["enrolled"])

        # 2. Face enrollment: consent first, then the guided poses.
        maria_face = unit(self.rng.normal(size=128))
        self.see_person(maria_face)
        refused = self.enroll_pose(admin, maria["id"], "frontal")
        self.assertEqual(refused.status_code, 428)
        self.assertEqual(refused.json["code"], "CONSENT_REQUIRED")

        for i, pose in enumerate(["frontal", "left", "right", "up", "down", "frontal_2"]):
            self.see_person(maria_face)
            res = self.enroll_pose(admin, maria["id"], pose, consent=(i == 0))
            self.assertEqual(res.status_code, 201, (pose, res.json))
        self.assertEqual(res.json["sample_count"], 6)
        self.assertTrue(res.json["enrollment_complete"])
        self.assertTrue(res.json["consent_recorded"])
        self.assertTrue(res.json["has_photo"])

        # 3. Someone else cannot be enrolled with Maria's face.
        other = self.client.post("/api/users", headers=admin, json={"full_name": "Impostor", "email": "imp@example.test"}).json
        self.see_person(maria_face)
        dup = self.enroll_pose(admin, other["id"], "frontal", consent=True)
        self.assertEqual(dup.status_code, 409)
        self.assertEqual(dup.json["code"], "DUPLICATE_FACE")

        # 4. Kiosk: Maria is recognised, blinks, and is clocked in. The
        #    admin's ordinary portal session can't punch; a locked kiosk can.
        self.assertEqual(self.scan(admin).json["code"], "KIOSK_REQUIRED")
        kiosk = self.open_kiosk()
        g.pop("current_user", None)
        self.assertEqual(self.client.get("/api/reports/today", headers=kiosk).json["code"], "KIOSK_LOCKED")
        self.see_person(maria_face, jitter=0.02)
        first = self.scan(kiosk)
        self.assertEqual(first.status_code, 201, first.json)
        self.assertEqual(first.json["status"], "MATCHED")
        self.assertEqual(first.json["event"]["user_name"], "Maria Santos")
        self.assertEqual(first.json["event"]["event_type"], "CLOCK_IN")
        self.assertGreater(first.json["score"], 0.9)

        # 5. An immediate second scan only re-confirms, it never double-punches.
        again = self.scan(kiosk)
        self.assertEqual(again.json["status"], "COOLDOWN")
        self.assertEqual(AttendanceEvent.query.filter_by(user_id=maria["id"]).count(), 1)

        # 6. Every matched check-in kept an audit snapshot linked to its event.
        snap = ScanSnapshot.query.filter_by(status="MATCHED").one()
        self.assertEqual(snap.event_id, AttendanceEvent.query.filter_by(user_id=maria["id"]).one().id)

        # 7. Reports and exports reflect it.
        g.pop("current_user", None)
        today = self.client.get("/api/reports/today", headers=admin).json
        self.assertEqual(today["present"], 1)
        self.assertEqual(today["currently_in"], 1)
        g.pop("current_user", None)
        daily = self.client.get("/api/reports/daily", headers=admin)
        self.assertEqual(daily.status_code, 200)
        self.assertIn("Maria Santos", daily.get_data(as_text=True))
        g.pop("current_user", None)
        csv_text = self.client.get("/api/reports/export.csv", headers=admin).get_data(as_text=True)
        self.assertIn("Maria Santos", csv_text)
        self.assertIn("Clock in", csv_text)
        g.pop("current_user", None)
        hours = self.client.get("/api/reports/hours-summary", headers=admin)
        self.assertEqual(hours.status_code, 200)
        self.assertEqual(hours.json["employees"][0]["user_name"], "Maria Santos")
        self.assertEqual(hours.json["totals"]["employees"], 1)
        g.pop("current_user", None)
        pdf = self.client.get(f"/api/reports/hours.pdf?user_id={maria['id']}", headers=admin)
        self.assertEqual(pdf.status_code, 200)
        self.assertEqual(pdf.mimetype, "application/pdf")
        self.assertTrue(pdf.data.startswith(b"%PDF"))

        # Re-checking the signed-in user's password (kept for sensitive actions).
        g.pop("current_user", None)
        ok = self.client.post("/api/auth/verify-password", json={"password": "test-password"}, headers=admin)
        self.assertEqual(ok.status_code, 200)
        g.pop("current_user", None)
        bad = self.client.post("/api/auth/verify-password", json={"password": "wrong"}, headers=admin)
        self.assertEqual(bad.status_code, 403)

        # 8. A stranger is refused, queued for review, and never punched.
        self.see_person(unit(self.rng.normal(size=128)))
        stranger = self.scan(kiosk, device="kiosk-2")
        self.assertEqual(stranger.json["status"], "NO_MATCH")
        self.assertEqual(AttendanceEvent.query.count(), 1)
        g.pop("current_user", None)
        queue = self.client.get("/api/review/snapshots?filter=pending", headers=admin).json
        self.assertEqual(queue["pending_count"], 1)
        item = queue["items"][0]
        g.pop("current_user", None)
        dismissed = self.client.post(f"/api/review/snapshots/{item['id']}/dismiss", headers=admin)
        self.assertEqual(dismissed.json["pending_count"], 0)

        # 9. Clearing all face data stops recognition but keeps attendance history.
        g.pop("current_user", None)
        cleared = self.client.delete("/api/enrollment/samples/all", headers=admin)
        self.assertEqual(cleared.status_code, 200)
        self.assertGreaterEqual(cleared.json["deleted_count"], 6)
        self.assertEqual(FaceEmbedding.query.filter_by(user_id=maria["id"]).count(), 0)
        self.assertEqual(AttendanceEvent.query.filter_by(user_id=maria["id"]).count(), 1)
        snapshot_service._throttle.clear()
        self.see_person(maria_face)
        self.assertEqual(self.scan(kiosk).json["status"], "NO_MATCH")

        # 10. Everything above left an audit trail.
        from app.models.audit_log import AuditLog
        actions = {a.action for a in AuditLog.query.all()}
        self.assertTrue({"FACE_SAMPLE_ENROLLED", "SNAPSHOT_DISMISSED", "FACE_DATA_CLEARED_ALL"} <= actions)

    def test_staff_role_is_fenced_off_from_admin_features(self):
        staff = {"Authorization": self.auth(self.staff_id)["Authorization"]}
        for method, url in [("get", "/api/review/snapshots"), ("delete", "/api/enrollment/samples/all"),
                            ("get", "/api/reports/today"), ("post", "/api/users")]:
            g.pop("current_user", None)
            res = getattr(self.client, method)(url, headers=staff)
            self.assertEqual(res.status_code, 403, (method, url))


if __name__ == "__main__":
    unittest.main()
