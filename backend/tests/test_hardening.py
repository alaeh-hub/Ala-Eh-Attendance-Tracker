import io
import unittest
from unittest import mock

import cv2
import numpy as np
from flask import g

from app.extensions import db
from app.models.attendance_event import AttendanceEvent
from app.models.face_embedding import FaceEmbedding
from app.models.scan_snapshot import ScanSnapshot
from app.models.user import User
from app.middleware.error_handler import AppError
from app.services.face_service import validate_burst_pixel_budget
from app.services.accuracy_eval import build_gallery, compute_curve, recommend
from app.utils import crypto
from app.vision.antispoof import resolve_mode, texture_realness
from app.vision.engines import _jitter_variants
from app.vision.enhance import enhance_for_embedding, needs_enhancement

from test_recognition_routes import BaseAppTest, TestConfig, jpeg, unit
from app import create_app


def _face_image(left=140, right=140, size=200):
    img = np.zeros((size, size, 3), dtype=np.uint8)
    img[:, : size // 2] = left
    img[:, size // 2:] = right
    return img


class EnhanceTests(unittest.TestCase):
    BOX = (0, 200, 200, 0)

    def test_evenly_lit_textured_face_is_left_alone(self):
        rng = np.random.default_rng(0)
        img = np.repeat(np.clip(rng.normal(130, 55, (200, 200, 1)), 0, 255).astype(np.uint8), 3, axis=2)
        self.assertFalse(needs_enhancement(img, self.BOX))
        self.assertIs(enhance_for_embedding(img, self.BOX), img)

    def test_side_lit_face_is_normalised(self):
        img = _face_image(left=200, right=90)
        self.assertTrue(needs_enhancement(img, self.BOX))
        self.assertIsNot(enhance_for_embedding(img, self.BOX), img)

    def test_disabled_flag_skips_enhancement(self):
        img = _face_image(left=200, right=90)
        self.assertIs(enhance_for_embedding(img, self.BOX, enabled=False), img)


class BurstImageBudgetTests(unittest.TestCase):
    @staticmethod
    def _png_header(width, height):
        return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big")

    def test_accepts_burst_within_total_pixel_budget(self):
        frames = [self._png_header(2000, 2000)] * 8
        validate_burst_pixel_budget(frames)

    def test_rejects_burst_over_total_pixel_budget_before_decode(self):
        frames = [self._png_header(2000, 2000)] * 9
        with self.assertRaises(AppError) as err:
            validate_burst_pixel_budget(frames)
        self.assertEqual(err.exception.status_code, 413)


class JitterTests(unittest.TestCase):
    def test_variants_cover_requested_jitters(self):
        aligned = np.full((112, 112, 3), 120, dtype=np.uint8)
        variants = _jitter_variants(aligned)
        self.assertEqual(len(variants), 5)  # 5 jitters = original + 4 variants used
        self.assertTrue(all(v.shape == aligned.shape for v in variants))


class AntiSpoofTests(unittest.TestCase):
    BOX = (0, 256, 256, 0)

    def test_natural_texture_scores_high(self):
        rng = np.random.default_rng(1)
        base = cv2.GaussianBlur(rng.normal(128, 40, (256, 256)).astype(np.float32), (0, 0), 3)
        img = cv2.cvtColor(np.clip(base + rng.normal(0, 6, base.shape), 0, 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
        self.assertGreater(texture_realness(img, self.BOX), 0.5)

    def test_flat_print_scores_low(self):
        img = np.full((256, 256, 3), 140, dtype=np.uint8)
        self.assertLess(texture_realness(img, self.BOX), 0.5)

    def test_pixel_grid_moire_scores_low(self):
        rng = np.random.default_rng(2)
        base = cv2.GaussianBlur(rng.normal(128, 30, (256, 256)).astype(np.float32), (0, 0), 3)
        x = np.arange(256)
        grid = 60 * np.sin(2 * np.pi * x / 3.5)[None, :] * np.ones((256, 1))
        img = cv2.cvtColor(np.clip(base + grid, 0, 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
        self.assertLess(texture_realness(img, self.BOX), 0.5)

    def test_mode_resolution(self):
        self.assertEqual(resolve_mode("auto", has_model=False), "log")
        self.assertEqual(resolve_mode("auto", has_model=True), "enforce")
        self.assertEqual(resolve_mode("off", has_model=True), "off")
        self.assertEqual(resolve_mode("bogus", has_model=True), "log")


class AccuracyEvalTests(unittest.TestCase):
    def test_curve_separates_known_from_unknown(self):
        rng = np.random.default_rng(3)
        centers = {p: unit(rng.normal(size=64)) for p in ("a", "b", "c")}

        def near(c):
            return unit(c + rng.normal(scale=0.08, size=64))

        gallery = build_gallery({p: np.vstack([near(c) for _ in range(3)]) for p, c in centers.items()})
        genuine = [(p, near(c)) for p, c in centers.items() for _ in range(5)]
        impostors = [unit(rng.normal(size=64)) for _ in range(30)]
        points = compute_curve(gallery, genuine, impostors, np.arange(0.3, 0.95, 0.05), margin=0.05)
        best, met = recommend(points, max_far=0.01)
        self.assertTrue(met)
        self.assertLessEqual(best.far, 0.01)
        self.assertLess(best.frr, 0.2)
        # Raising the threshold never makes FAR worse.
        fars = [p.far for p in points]
        self.assertEqual(fars, sorted(fars, reverse=True))


class CryptoTests(BaseAppTest):
    KEY = "Vn5R1bXn0Pq0Wm2cWZc8vJ0e2o2W1m0O3m0rGSMu2tU="

    def test_plaintext_when_no_key(self):
        self.assertEqual(crypto.encrypt_text("abc"), "abc")
        self.assertEqual(crypto.encrypt_bytes(b"xyz"), b"xyz")

    def test_roundtrip_and_legacy_plaintext_still_readable(self):
        self.app.config["FACE_DATA_KEY"] = self.KEY
        token = crypto.encrypt_text("[1, 2, 3]")
        self.assertTrue(token.startswith(crypto.TEXT_PREFIX))
        self.assertNotIn("1, 2, 3", token)
        self.assertEqual(crypto.decrypt_text(token), "[1, 2, 3]")
        self.assertEqual(crypto.decrypt_text("[4, 5]"), "[4, 5]")  # written before the key existed
        raw = crypto.encrypt_bytes(b"\xff\xd8jpeg")
        self.assertTrue(crypto.is_encrypted(raw))
        self.assertEqual(crypto.decrypt_bytes(raw), b"\xff\xd8jpeg")

    def test_wrong_key_raises(self):
        self.app.config["FACE_DATA_KEY"] = self.KEY
        token = crypto.encrypt_text("secret")
        self.app.config["FACE_DATA_KEY"] = "uBmwX4N0yGJ1m9k6Xc0u2Z4Wv0n3o5L7q9S1t3V5x7A="
        with self.assertRaises(crypto.CryptoError):
            crypto.decrypt_text(token)

    def test_embeddings_encrypted_at_rest_but_still_match(self):
        self.app.config["FACE_DATA_KEY"] = self.KEY
        emb = FaceEmbedding(user_id=self.staff_id, pose_label="left", model=self.engine.name)
        emb.vector = self.face_a.tolist()
        db.session.add(emb)
        db.session.commit()
        self.assertTrue(emb.vector_json.startswith(crypto.TEXT_PREFIX))
        np.testing.assert_allclose(emb.vector, self.face_a.tolist(), atol=1e-6)
        from app.services.embedding_index import embedding_index
        embedding_index.invalidate()
        self.assertEqual(embedding_index.rank(self.face_a)[0][0], self.staff_id)


class ConsentAndAuditTests(BaseAppTest):
    def test_enrollment_requires_consent_then_remembers_it(self):
        new = self.client.post("/api/users", headers=self.auth(), json={"full_name": "New Hire", "email": "new@example.test"}).json
        self.assertFalse(new["consent_recorded"])
        from contextlib import ExitStack
        from app.vision.engines import Face
        rng_face = unit(np.random.default_rng(99).normal(size=128))

        def post(**extra):
            stack = ExitStack()
            stack.enter_context(mock.patch.object(self.engine, "detect", return_value=[Face(box=(20, 220, 220, 20), score=0.99)]))
            stack.enter_context(mock.patch.object(self.engine, "embed", return_value=rng_face))
            stack.enter_context(mock.patch("app.services.face_service.assess_quality", return_value={"ok": True, "score": 0.9, "reason": None}))
            with stack:
                return self.client.post("/api/enrollment/sample", headers=self.auth(), content_type="multipart/form-data",
                                        data={"image": (jpeg(), "a.jpg"), "target_user_id": new["id"], "pose": "frontal", **extra})

        res = post()
        self.assertEqual(res.status_code, 428)
        self.assertEqual(res.json["code"], "CONSENT_REQUIRED")
        res = post(consent="true")
        self.assertEqual(res.status_code, 201, res.json)
        self.assertTrue(res.json["consent_recorded"])
        self.assertIsNotNone(db.session.get(User, new["id"]).biometric_consent_by)
        from app.models.audit_log import AuditLog
        self.assertTrue(AuditLog.query.filter_by(action="FACE_SAMPLE_ENROLLED").count())


class SnapshotReviewTests(BaseAppTest):
    def setUp(self):
        super().setUp()
        from app.services import snapshot_service
        snapshot_service._throttle.clear()

    def _burst(self, status, **extra):
        ok, buf = cv2.imencode(".jpg", np.full((120, 160, 3), 90, dtype=np.uint8))
        return {"status": status, "user_id": self.staff_id if status == "MATCHED" else None, "score": 0.9,
                "runner_up_score": 0.3, "ears": [(0.3, 0.3), (0.31, 0.3), (0.14, 0.13), (0.3, 0.31)],
                "frames_with_face": 3, "elapsed_ms": 5, "snapshot_jpeg": buf.tobytes(), "spoof_score": 0.9, **extra}

    def _checkin(self, burst):
        with mock.patch("app.api.recognition_routes.recognize_burst", return_value=burst):
            return self.client.post("/api/recognition/check-in", headers=self.kiosk_auth(), content_type="multipart/form-data",
                                    data={"frames": [(jpeg(), "f.jpg")], "device_id": "kiosk-1"})

    def test_matched_checkin_keeps_audit_snapshot_linked_to_event(self):
        res = self._checkin(self._burst("MATCHED"))
        self.assertEqual(res.status_code, 201, res.json)
        snap = ScanSnapshot.query.filter_by(status="MATCHED").one()
        self.assertEqual(snap.event_id, AttendanceEvent.query.one().id)
        self.assertEqual(snap.user_id, self.staff_id)

    def test_unknown_scan_lands_in_pending_queue_and_is_throttled(self):
        self._checkin(self._burst("NO_MATCH", candidate_user_id=self.staff_id))
        self._checkin(self._burst("NO_MATCH"))  # same device+status within the throttle window
        self.assertEqual(ScanSnapshot.query.filter_by(status="NO_MATCH").count(), 1)
        listing = self.client.get("/api/review/snapshots?filter=pending", headers=self.auth()).json
        self.assertEqual(listing["pending_count"], 1)
        self.assertEqual(listing["items"][0]["candidate_name"], "Juan Dela Cruz")

    def test_spoof_suspected_blocks_punch_and_is_queued(self):
        res = self._checkin(self._burst("MATCHED", spoof_suspected=True, spoof_score=0.1))
        self.assertEqual(res.json["status"], "SPOOF_SUSPECTED")
        self.assertEqual(AttendanceEvent.query.count(), 0)
        self.assertEqual(ScanSnapshot.query.filter_by(status="SPOOF_SUSPECTED").count(), 1)

    def test_review_actions_and_admin_only(self):
        self._checkin(self._burst("NO_MATCH"))
        snap = ScanSnapshot.query.one()
        g.pop("current_user", None)
        self.assertEqual(self.client.get("/api/review/snapshots", headers=self.auth(self.staff_id)).status_code, 403)
        g.pop("current_user", None)
        img = self.client.get(f"/api/review/snapshots/{snap.id}/image", headers=self.auth())
        self.assertEqual(img.status_code, 200)
        self.assertEqual(img.mimetype, "image/jpeg")
        res = self.client.post(f"/api/review/snapshots/{snap.id}/dismiss", headers=self.auth())
        self.assertEqual(res.json["pending_count"], 0)
        self.assertEqual(db.session.get(ScanSnapshot, snap.id).resolution, "DISMISSED")
        self.assertEqual(self.client.delete(f"/api/review/snapshots/{snap.id}", headers=self.auth()).status_code, 200)
        self.assertEqual(ScanSnapshot.query.count(), 0)

    def test_enroll_from_snapshot_adds_sample_and_resolves(self):
        from app.vision.engines import Face
        self._checkin(self._burst("LOW_CONFIDENCE"))
        snap = ScanSnapshot.query.one()
        before = FaceEmbedding.query.filter_by(user_id=self.staff_id).count()
        with mock.patch.object(self.engine, "detect", return_value=[Face(box=(20, 100, 100, 20), score=0.99)]), \
                mock.patch.object(self.engine, "embed", return_value=self.face_a), \
                mock.patch("app.services.face_service.assess_quality", return_value={"ok": True, "score": 0.9, "reason": None}):
            res = self.client.post(f"/api/review/snapshots/{snap.id}/enroll", headers=self.auth(), json={"user_id": self.staff_id})
        self.assertEqual(res.status_code, 200, res.json)
        self.assertEqual(FaceEmbedding.query.filter_by(user_id=self.staff_id).count(), before + 1)
        self.assertEqual(db.session.get(ScanSnapshot, snap.id).resolution, "ADDED")

    def test_old_snapshots_are_purged(self):
        from datetime import datetime, timedelta
        from app.services.snapshot_service import purge_old
        db.session.add(ScanSnapshot(status="NO_MATCH", image=b"x", created_at=datetime.utcnow() - timedelta(days=45)))
        db.session.add(ScanSnapshot(status="NO_MATCH", image=b"x"))
        db.session.commit()
        self.assertEqual(purge_old(force=True), 1)
        self.assertEqual(ScanSnapshot.query.count(), 1)


if __name__ == "__main__":
    unittest.main()


class SocketOriginTests(unittest.TestCase):
    """The live feed must accept the site's own origin behind the proxy even
    when CORS_ORIGINS doesn't list it, and still refuse foreign origins."""

    ENV = {"HTTP_HOST": "backend:5000", "wsgi.url_scheme": "http",
           "HTTP_X_FORWARDED_PROTO": "https", "HTTP_X_FORWARDED_HOST": "attendance.example.com"}

    def _check(self, hops):
        from types import SimpleNamespace

        from app import _socket_origin_check
        return _socket_origin_check(SimpleNamespace(config={"CORS_ORIGINS": ["http://localhost:5173"],
                                                             "TRUST_PROXY_HOPS": hops}))

    def test_same_origin_behind_trusted_proxy(self):
        check = self._check(1)
        self.assertTrue(check("https://attendance.example.com", self.ENV))
        self.assertTrue(check("http://localhost:5173", self.ENV))
        self.assertFalse(check("https://evil.example", self.ENV))

    def test_forwarded_host_ignored_without_trusted_proxy(self):
        check = self._check(0)
        self.assertFalse(check("https://attendance.example.com", self.ENV))
        self.assertTrue(check("http://backend:5000", self.ENV))


class LoggingResilienceTests(unittest.TestCase):
    def test_unwritable_log_dir_does_not_crash_startup(self):
        import logging
        from types import SimpleNamespace

        from app.logging_config import configure_logging

        with mock.patch("app.logging_config.RotatingFileHandler", side_effect=PermissionError(13, "denied")):
            configure_logging(SimpleNamespace(config={"LOG_DIR": "/nonexistent-readonly", "LOG_LEVEL": "INFO"},
                                              logger=logging.getLogger("t")))
        self.assertTrue(logging.getLogger().handlers)
