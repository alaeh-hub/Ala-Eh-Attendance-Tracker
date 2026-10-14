import csv
import io
import unittest
from datetime import datetime, timedelta
from unittest import mock

import cv2
import numpy as np
from flask import g
from flask_jwt_extended import create_access_token, create_refresh_token, decode_token

from app import create_app
from app.extensions import db
from app.models.attendance_event import AttendanceEvent
from app.models.department import Department
from app.models.face_embedding import FaceEmbedding
from app.models.user import User
from app.services.embedding_index import active_engine, embedding_index
from app.vision.engines import Face
from app.vision.liveness import LivenessTracker, evaluate_blink
from app.vision.matcher import classify_match, rank_users
from app.utils.ratelimit import reset_rate_limits
from app.utils.security import hash_password
from config import Config


def unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v)


def jpeg(color=(40, 40, 40)):
    img = np.full((240, 320, 3), color, dtype=np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    return io.BytesIO(buf.tobytes())


TEST_PASSWORD_HASH = hash_password("test-password")


class TestConfig(Config):
    # Do not inherit APP_ENV=production from a developer's local .env file.
    APP_ENV = "testing"
    # Most tests exercise plaintext storage; encryption-specific tests opt in.
    FACE_DATA_KEY = None
    SQLALCHEMY_DATABASE_URI = "sqlite://"
    TESTING = True
    ENROLL_NUM_JITTERS = 1


class BaseAppTest(unittest.TestCase):
    def setUp(self):
        reset_rate_limits()  # the limiter is process-wide; start every test with a clean slate
        self.app = create_app(TestConfig)
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.client = self.app.test_client()

        rng = np.random.default_rng(7)
        self.face_a = unit(rng.normal(size=128))
        self.face_b = unit(rng.normal(size=128))

        admin = User(full_name="Admin", email="admin@example.test", password_hash=TEST_PASSWORD_HASH, role="ADMIN")
        staff = User(full_name="Juan Dela Cruz", email="juan@example.test", password_hash=TEST_PASSWORD_HASH, employee_code="EMP-0001", biometric_consent_at=datetime.utcnow())
        db.session.add_all([admin, staff])
        db.session.flush()
        self.admin_id, self.staff_id = admin.id, staff.id
        self.engine = active_engine()
        for _ in range(3):
            e = FaceEmbedding(user_id=staff.id, pose_label="frontal", model=self.engine.name)
            e.vector = unit(self.face_a + rng.normal(scale=0.01, size=128)).tolist()
            db.session.add(e)
        e = FaceEmbedding(user_id=admin.id, pose_label="frontal", model=self.engine.name)
        e.vector = self.face_b.tolist()
        db.session.add(e)
        db.session.commit()
        embedding_index.invalidate()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def auth(self, user_id=None, kiosk=False):
        """Bearer header for a session of `user_id` (default: the admin), carrying
        the user's current token_version like a real login would."""
        user = db.session.get(User, user_id or self.admin_id)
        claims = {"tv": user.token_version or 0, "kiosk": kiosk}
        return {"Authorization": f"Bearer {create_access_token(identity=user.id, additional_claims=claims)}"}

    def kiosk_auth(self, user_id=None):
        """A kiosk-locked session, which check-in requires."""
        return self.auth(user_id, kiosk=True)


class MatcherTests(unittest.TestCase):
    def test_rank_users_combines_max_and_centroid(self):
        a, b = unit([1, 0, 0]), unit([0, 1, 0])
        matrix = np.vstack([a, unit([0.9, 0.1, 0]), b])
        owners = np.array([0, 0, 1])
        centroids = np.vstack([unit(a + unit([0.9, 0.1, 0])), b])
        ranked = rank_users(a, matrix, owners, centroids, ["u1", "u2"])
        self.assertEqual(ranked[0][0], "u1")
        self.assertGreater(ranked[0][1], 0.95)

    def test_classify_statuses(self):
        self.assertEqual(classify_match([], 0.8, 0.04)["status"], "NO_MATCH")
        self.assertEqual(classify_match([("a", 0.93), ("b", 0.60)], 0.8, 0.04)["status"], "MATCHED")
        self.assertEqual(classify_match([("a", 0.90), ("b", 0.88)], 0.8, 0.04)["status"], "AMBIGUOUS_MATCH")
        self.assertEqual(classify_match([("a", 0.76)], 0.8, 0.04)["status"], "LOW_CONFIDENCE")
        self.assertEqual(classify_match([("a", 0.50)], 0.8, 0.04)["status"], "NO_MATCH")


class LivenessTests(unittest.TestCase):
    OPEN = [(0.33, 0.31), (0.34, 0.30), (0.32, 0.31), (0.33, 0.32)]

    def test_blink_with_both_eyes_passes(self):
        self.assertTrue(evaluate_blink(self.OPEN + [(0.15, 0.14)], 0.06)["passed"])

    def test_photo_landmark_noise_fails(self):
        # Real measurement from a still photo: EAR wobbles ~9% between frames.
        noise = [(0.386, 0.336), (0.363, 0.324), (0.339, 0.299), (0.417, 0.356), (0.349, 0.302), (0.372, 0.33)]
        self.assertFalse(evaluate_blink(noise * 6, 0.06)["passed"])

    def test_one_eye_only_fails(self):
        # Winking / one-eye landmark glitch is not a blink.
        self.assertFalse(evaluate_blink(self.OPEN + [(0.14, 0.31)], 0.06)["passed"])

    def test_tracker_pools_samples_across_scans(self):
        tracker = LivenessTracker()
        self.assertFalse(tracker.add_and_evaluate(("k", "u"), self.OPEN, 8, 0.06)["passed"])
        self.assertTrue(tracker.add_and_evaluate(("k", "u"), [(0.14, 0.13), (0.33, 0.31)], 8, 0.06)["passed"])
        # blink is consumed
        self.assertFalse(tracker.add_and_evaluate(("k", "u"), self.OPEN, 8, 0.06)["passed"])


class EmbeddingIndexTests(BaseAppTest):
    def test_index_ranks_enrolled_user_first(self):
        ranked = embedding_index.rank(self.face_a)
        self.assertEqual(ranked[0][0], self.staff_id)
        self.assertGreater(ranked[0][1], 0.95)

    def test_deactivated_users_are_not_matched(self):
        self.client.patch(f"/api/users/{self.staff_id}", headers=self.auth(), json={"is_active": False})
        self.assertNotIn(self.staff_id, [u for u, _ in embedding_index.rank(self.face_a)])


class CheckInRouteTests(BaseAppTest):
    def _post(self, frames=3):
        return self.client.post(
            "/api/recognition/check-in",
            headers=self.kiosk_auth(),
            data={"frames": [(jpeg(), f"f{i}.jpg") for i in range(frames)], "device_id": "kiosk-1"},
            content_type="multipart/form-data",
        )

    def test_requires_authentication(self):
        res = self.client.post("/api/recognition/check-in", data={}, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 401)

    def test_blank_frames_return_no_face(self):
        res = self._post()
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json["status"], "NO_FACE")

    def _fake_burst(self, ears):
        return {"status": "MATCHED", "user_id": self.staff_id, "score": 0.93, "runner_up_score": 0.4,
                "ears": ears, "frames_with_face": 3, "elapsed_ms": 10}

    def test_match_with_blink_records_clock_in_then_cooldown(self):
        with mock.patch("app.api.recognition_routes.recognize_burst",
                        return_value=self._fake_burst([(0.30, 0.31), (0.31, 0.30), (0.14, 0.13), (0.31, 0.31), (0.30, 0.30)])):
            first = self._post()
            second = self._post()
        self.assertEqual(first.status_code, 201)
        self.assertEqual(first.json["event"]["event_type"], "CLOCK_IN")
        self.assertEqual(first.json["event"]["user_name"], "Juan Dela Cruz")
        self.assertTrue(first.json["event"]["timestamp"].endswith("Z"))
        self.assertEqual(second.json["status"], "COOLDOWN")
        self.assertEqual(AttendanceEvent.query.count(), 1)

    def test_match_without_blink_is_not_recorded(self):
        with mock.patch("app.api.recognition_routes.recognize_burst",
                        return_value=self._fake_burst([(0.30, 0.31), (0.31, 0.30), (0.30, 0.31), (0.31, 0.31)])):
            res = self._post()
        self.assertEqual(res.json["status"], "LIVENESS_FAILED")
        self.assertEqual(res.json["first_name"], "Juan")
        self.assertEqual(AttendanceEvent.query.count(), 0)

    def test_borrowed_blink_discards_pooled_samples(self):
        # Scan 1 pools open-open-closed (no blink yet); scan 2 is flagged as a
        # borrowed blink; scan 3's open frames would complete the pooled blink
        # if the tainted samples had survived.
        first = self._fake_burst([(0.30, 0.31), (0.31, 0.30), (0.14, 0.13)])
        mismatch = {**self._fake_burst([]), "liveness_identity_mismatch": True}
        last = self._fake_burst([(0.31, 0.31), (0.30, 0.30)])
        with mock.patch("app.api.recognition_routes.recognize_burst", side_effect=[first, mismatch, last]):
            responses = [self._post() for _ in range(3)]
        self.assertEqual([r.json["status"] for r in responses], ["LIVENESS_FAILED"] * 3)
        self.assertEqual(AttendanceEvent.query.count(), 0)

    def test_first_scan_of_new_day_is_clock_in(self):
        from app.utils.timezone import utcnow
        db.session.add(AttendanceEvent(user_id=self.staff_id, event_type="CLOCK_IN",
                                       timestamp=utcnow() - timedelta(days=1), match_score=0.9,
                                       match_status="MATCHED"))
        db.session.commit()
        from app.services.attendance_service import determine_event_type
        self.assertEqual(determine_event_type(self.staff_id, "AM"), "CLOCK_IN")


class EmployeeAndEnrollmentTests(BaseAppTest):
    def _fake_face(self, vector):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(mock.patch.object(self.engine, "detect", return_value=[Face(box=(20, 220, 220, 20), score=0.99)]))
        stack.enter_context(mock.patch.object(self.engine, "embed", return_value=vector))
        stack.enter_context(mock.patch("app.services.face_service.assess_quality",
                                       return_value={"ok": True, "score": 0.9, "reason": None}))
        return stack

    def test_enroll_accepts_consistent_sample_and_counts_it(self):
        with self._fake_face(self.face_a):
            res = self.client.post("/api/enrollment/sample", headers=self.auth(),
                                   data={"image": (jpeg(), "a.jpg"), "target_user_id": self.staff_id, "pose": "left"},
                                   content_type="multipart/form-data")
        self.assertEqual(res.status_code, 201, res.json)
        self.assertEqual(res.json["sample_count"], 4)
        self.assertTrue(db.session.get(User, self.staff_id).photo)

    def test_photo_endpoint_serves_enrolled_photo(self):
        with self._fake_face(self.face_a):
            self.client.post("/api/enrollment/sample", headers=self.auth(),
                             data={"image": (jpeg(), "a.jpg"), "target_user_id": self.staff_id, "pose": "left"},
                             content_type="multipart/form-data")
        res = self.client.get(f"/api/users/{self.staff_id}/photo", headers=self.auth())
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.mimetype, "image/jpeg")
        self.assertTrue(res.data.startswith(b"\xff\xd8"))

    def test_legacy_samples_from_other_engine_are_reported_outdated(self):
        e = FaceEmbedding(user_id=self.staff_id, pose_label="frontal", model="legacy-x")
        e.vector = self.face_a.tolist()
        db.session.add(e)
        db.session.commit()
        status = self.client.get(f"/api/enrollment/status?target_user_id={self.staff_id}", headers=self.auth()).json
        self.assertEqual(status["sample_count"], 3)
        self.assertEqual(status["outdated_samples"], 1)

    def test_admin_creates_employee_without_login(self):
        res = self.client.post("/api/users", headers=self.auth(), json={
            "full_name": "Maria Santos", "email": "maria@example.test",
            "department": "Production", "position": "Packer",
        })
        self.assertEqual(res.status_code, 201, res.json)
        self.assertEqual(res.json["employee_code"], "EMP-0002")
        self.assertFalse(res.json["can_login"])
        self.assertFalse(res.json["enrolled"])
        login = self.client.post("/api/auth/login", json={"email": "maria@example.test", "password": ""})
        self.assertEqual(login.status_code, 401)

    def test_duplicate_employee_code_rejected(self):
        res = self.client.post("/api/users", headers=self.auth(), json={
            "full_name": "Dup", "email": "dup@example.test", "employee_code": "emp-0001"})
        self.assertEqual(res.status_code, 409)

    def test_staff_cannot_create_or_enroll(self):
        res = self.client.post("/api/users", headers=self.auth(self.staff_id), json={
            "full_name": "X", "email": "x@example.test"})
        self.assertEqual(res.status_code, 403)
        res = self.client.post("/api/enrollment/sample", headers=self.auth(self.staff_id),
                               data={"image": (jpeg(), "a.jpg")}, content_type="multipart/form-data")
        self.assertEqual(res.status_code, 403)

    def test_enroll_rejects_face_already_enrolled_as_someone_else(self):
        new = self.client.post("/api/users", headers=self.auth(), json={
            "full_name": "Impostor", "email": "imp@example.test"}).json
        with self._fake_face(self.face_a):
            res = self.client.post("/api/enrollment/sample", headers=self.auth(),
                                   data={"image": (jpeg(), "a.jpg"), "target_user_id": new["id"], "pose": "frontal", "consent": "true"},
                                   content_type="multipart/form-data")
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json["code"], "DUPLICATE_FACE")
        self.assertIn("Juan Dela Cruz", res.json["error"])

    def test_enroll_rejects_inconsistent_face(self):
        with self._fake_face(unit(np.random.default_rng(1).normal(size=128))):
            res = self.client.post("/api/enrollment/sample", headers=self.auth(),
                                   data={"image": (jpeg(), "a.jpg"), "target_user_id": self.staff_id},
                                   content_type="multipart/form-data")
        self.assertEqual(res.status_code, 422)
        self.assertEqual(res.json["code"], "INCONSISTENT_FACE")

    def test_reset_only_affects_target(self):
        res = self.client.delete(f"/api/enrollment/samples?target_user_id={self.staff_id}", headers=self.auth())
        self.assertEqual(res.status_code, 200)
        self.assertEqual(FaceEmbedding.query.filter_by(user_id=self.staff_id).count(), 0)
        self.assertEqual(FaceEmbedding.query.filter_by(user_id=self.admin_id).count(), 1)

    def test_public_registration_disabled(self):
        res = self.client.post("/api/auth/register", json={
            "full_name": "U", "email": "u@example.test", "password": "temporary-password", "role": "ADMIN"})
        self.assertEqual(res.status_code, 403)
        self.assertIsNone(User.query.filter_by(email="u@example.test").first())


class SessionAndDepartmentValidationTests(BaseAppTest):
    def test_deactivated_user_session_is_unauthorized(self):
        updated = self.client.patch(f"/api/users/{self.staff_id}", headers=self.auth(), json={"is_active": False})
        self.assertFalse(updated.json["is_active"])

        staff_auth = self.auth(self.staff_id)
        token = staff_auth["Authorization"].split()[1]
        self.assertEqual(decode_token(token)["sub"], self.staff_id)
        # BaseAppTest holds an app context open around multiple test-client
        # requests; clear its request-user cache to model a fresh HTTP request.
        g.pop("current_user", None)
        response = self.client.get("/api/auth/me", headers=staff_auth)

        self.assertEqual(response.status_code, 401)

    def test_revoking_login_invalidates_existing_access_and_refresh_tokens(self):
        access_auth = self.auth(self.staff_id)
        refresh_token = create_refresh_token(identity=self.staff_id)
        response = self.client.patch(
            f"/api/users/{self.staff_id}",
            headers=self.auth(),
            json={"revoke_login": True},
        )
        self.assertEqual(response.status_code, 200)
        g.pop("current_user", None)

        access_response = self.client.get("/api/auth/me", headers=access_auth)
        refresh_response = self.client.post(
            "/api/auth/refresh",
            headers={"Authorization": f"Bearer {refresh_token}"},
        )

        self.assertEqual(access_response.status_code, 401)
        self.assertEqual(refresh_response.status_code, 401)

    def test_invalid_shifting_value_does_not_clear_department_shifts(self):
        created = self.client.post("/api/departments", headers=self.auth(), json={
            "name": "Night shift",
            "has_shifting": True,
            "shifts": [{"name": "Night", "start_time": "22:00", "end_time": "06:00"}],
        })
        self.assertEqual(created.status_code, 201, created.json)
        dept_id = created.json["id"]

        response = self.client.patch(
            f"/api/departments/{dept_id}",
            headers=self.auth(),
            json={"has_shifting": "false"},
        )

        self.assertEqual(response.status_code, 400)
        department = db.session.get(Department, dept_id)
        self.assertTrue(department.has_shifting)
        self.assertEqual(department.shifts[0]["name"], "Night")


class ReportTests(BaseAppTest):
    def test_today_and_csv(self):
        from app.services.attendance_service import record_attendance
        record_attendance(self.staff_id, 0.93, "MATCHED", True, "kiosk-1")
        today = self.client.get("/api/reports/today", headers=self.auth()).json
        self.assertEqual(today["present"], 1)
        self.assertEqual(today["currently_in"], 1)
        self.assertEqual(today["total_employees"], 2)
        daily = self.client.get("/api/reports/daily", headers=self.auth()).json
        self.assertEqual(daily[0]["user_name"], "Juan Dela Cruz")
        csv = self.client.get("/api/reports/export.csv", headers=self.auth())
        self.assertIn("Juan Dela Cruz", csv.get_data(as_text=True))

    def test_export_includes_session_and_escapes_formula_text(self):
        self.client.patch(
            f"/api/users/{self.admin_id}",
            headers=self.auth(),
            json={"full_name": "=2+2"},
        )
        from app.services.attendance_service import record_attendance
        record_attendance(
            self.admin_id,
            0.0,
            "MANUAL",
            False,
            event_type="CLOCK_IN",
            session="OT",
            notes="@SUM(A1:A2)",
            enforce_cooldown=False,
        )

        response = self.client.get("/api/reports/export.csv", headers=self.auth())
        rows = list(csv.reader(io.StringIO(response.get_data(as_text=True).lstrip("\ufeff"))))

        self.assertEqual(rows[0][6], "Session")
        self.assertEqual(rows[1][3], "'=2+2")
        self.assertEqual(rows[1][6], "OT")
        self.assertEqual(rows[1][-1], "'@SUM(A1:A2)")


if __name__ == "__main__":
    unittest.main()
