"""
Sessions and access control: refresh cookie + CSRF, logout and token_version
revocation, the server-enforced kiosk lock, the KIOSK device role, rate
limits and sign-in lockout, archive-vs-delete of users, audit entries.
"""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from flask_jwt_extended import decode_token  # noqa: E402

from app.extensions import db, socketio  # noqa: E402
from app.models.attendance_event import AttendanceEvent  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.face_embedding import FaceEmbedding  # noqa: E402
from app.models.revoked_token import RevokedToken  # noqa: E402
from app.models.scan_snapshot import ScanSnapshot  # noqa: E402
from app.models.user import User  # noqa: E402
from app.utils.ratelimit import LoginGuard, SlidingWindowLimiter  # noqa: E402
from test_recognition_routes import TEST_PASSWORD_HASH, BaseAppTest, jpeg  # noqa: E402

PASSWORD = "test-password"
REFRESH_COOKIE = "refresh_token_cookie"
CSRF_COOKIE = "csrf_refresh_token"


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


class AuthTestBase(BaseAppTest):
    def setUp(self):
        super().setUp()
        self.app.config["RATE_LIMITS_ENABLED"] = True
        operator = User(full_name="Olive Operator", email="op@example.test", password_hash=TEST_PASSWORD_HASH,
                        role="OPERATOR")
        kiosk = User(full_name="Lobby Tablet", email="lobby@example.test", password_hash=TEST_PASSWORD_HASH,
                     role="KIOSK", employee_code="KIOSK-01")
        db.session.add_all([operator, kiosk])
        db.session.commit()
        self.operator_id, self.kiosk_id = operator.id, kiosk.id

    def login(self, email="admin@example.test", password=PASSWORD):
        return self.client.post("/api/auth/login", json={"email": email, "password": password})

    def cookie(self, name):
        path = "/api/auth" if name == REFRESH_COOKIE else "/"
        c = self.client.get_cookie(name, path=path)
        return c.value if c else None

    def refresh_with_cookie(self, csrf=True):
        headers = {"X-CSRF-TOKEN": self.cookie(CSRF_COOKIE)} if csrf else {}
        return self.client.post("/api/auth/refresh", headers=headers)

    def audit_actions(self):
        return [a.action for a in AuditLog.query.order_by(AuditLog.created_at).all()]


class LoginAndRefreshTests(AuthTestBase):
    def test_login_puts_refresh_token_only_in_an_httponly_cookie(self):
        res = self.login()
        self.assertEqual(res.status_code, 200, res.json)
        self.assertIn("access_token", res.json)
        self.assertNotIn("refresh_token", res.json)
        self.assertFalse(res.json["kiosk_locked"])
        self.assertEqual(res.json["user"]["email"], "admin@example.test")
        set_cookies = res.headers.getlist("Set-Cookie")
        refresh = next(c for c in set_cookies if c.startswith(REFRESH_COOKIE + "="))
        self.assertIn("HttpOnly", refresh)
        self.assertIn("Path=/api/auth", refresh)
        self.assertTrue(any(c.startswith(CSRF_COOKIE + "=") for c in set_cookies))

    def test_cookie_refresh_requires_the_csrf_header(self):
        self.login()
        res = self.refresh_with_cookie(csrf=False)
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.json["code"], "CSRF_FAILED")
        res = self.client.post("/api/auth/refresh", headers={"X-CSRF-TOKEN": "forged"})
        self.assertEqual(res.status_code, 401)

        res = self.refresh_with_cookie()
        self.assertEqual(res.status_code, 200, res.json)
        self.assertFalse(res.json["kiosk_locked"])
        self.assertEqual(self.client.get("/api/auth/me", headers=bearer(res.json["access_token"])).status_code, 200)

    def test_cookie_wins_over_an_access_token_in_the_authorization_header(self):
        access = self.login().json["access_token"]
        res = self.client.post("/api/auth/refresh",
                               headers={**bearer(access), "X-CSRF-TOKEN": self.cookie(CSRF_COOKIE)})
        self.assertEqual(res.status_code, 200, res.json)

    def test_bearer_refresh_token_works_without_cookies(self):
        self.login()
        refresh_token = self.cookie(REFRESH_COOKIE)
        self.client.delete_cookie(REFRESH_COOKIE, path="/api/auth")
        res = self.client.post("/api/auth/refresh", headers=bearer(refresh_token))
        self.assertEqual(res.status_code, 200, res.json)

    def test_access_token_cannot_be_used_to_refresh(self):
        access = self.login().json["access_token"]
        self.client.delete_cookie(REFRESH_COOKIE, path="/api/auth")
        self.assertEqual(self.client.post("/api/auth/refresh", headers=bearer(access)).status_code, 401)

    def test_unknown_email_costs_a_bcrypt_check_and_gives_the_same_error(self):
        with mock.patch("app.services.auth_service.burn_password_check") as burn:
            res = self.login(email="nobody@example.test")
        self.assertEqual(res.status_code, 401)
        burn.assert_called_once()
        self.assertEqual(res.json["error"], self.login(password="wrong-password").json["error"])

    def test_deactivation_is_only_revealed_after_the_right_password(self):
        db.session.get(User, self.operator_id).is_active = False
        db.session.commit()
        self.assertEqual(self.login("op@example.test", "wrong-password").status_code, 401)
        self.assertEqual(self.login("op@example.test").status_code, 403)

    def test_failed_login_is_logged_with_email_and_ip(self):
        with self.assertLogs("app.auth", level="WARNING") as logs:
            self.login(password="wrong-password")
        self.assertTrue(any("admin@example.test" in line and "ip=" in line for line in logs.output))
        self.assertFalse(any("wrong-password" in line for line in logs.output))


class LogoutAndRevocationTests(AuthTestBase):
    def test_logout_revokes_refresh_and_access_tokens_and_clears_cookies(self):
        access = self.login().json["access_token"]
        refresh_token = self.cookie(REFRESH_COOKIE)
        res = self.client.post("/api/auth/logout", headers=bearer(access))
        self.assertEqual(res.status_code, 200)
        self.assertIsNone(self.cookie(REFRESH_COOKIE))
        self.assertEqual(RevokedToken.query.count(), 2)

        me = self.client.get("/api/auth/me", headers=bearer(access))
        self.assertEqual(me.status_code, 401)
        self.assertEqual(me.json["code"], "TOKEN_REVOKED")
        again = self.client.post("/api/auth/refresh", headers=bearer(refresh_token))
        self.assertEqual(again.status_code, 401)
        self.assertEqual(again.json["code"], "TOKEN_REVOKED")

    def test_logout_never_fails(self):
        self.assertEqual(self.client.post("/api/auth/logout").status_code, 200)
        self.assertEqual(self.client.post("/api/auth/logout", headers=bearer("garbage")).status_code, 200)

    def test_expired_revocations_are_purged(self):
        from datetime import datetime, timedelta
        db.session.add(RevokedToken(jti="old", token_type="access", user_id=self.admin_id,
                                    expires_at=datetime.utcnow() - timedelta(minutes=1)))
        db.session.commit()
        access = self.login().json["access_token"]
        self.client.post("/api/auth/logout", headers=bearer(access))
        self.assertIsNone(db.session.get(RevokedToken, "old"))

    def _revoked_after(self, change: dict):
        login = self.login("op@example.test")
        access, refresh_token = login.json["access_token"], self.cookie(REFRESH_COOKIE)
        self.assertEqual(self.client.get("/api/auth/me", headers=bearer(access)).status_code, 200)
        res = self.client.patch(f"/api/users/{self.operator_id}", headers=self.auth(), json=change)
        self.assertEqual(res.status_code, 200, res.json)
        me = self.client.get("/api/auth/me", headers=bearer(access))
        self.assertEqual(me.status_code, 401)
        refreshed = self.client.post("/api/auth/refresh", headers=bearer(refresh_token))
        self.assertEqual(refreshed.status_code, 401)
        return me

    def test_password_change_signs_the_user_out_everywhere(self):
        self.assertEqual(self._revoked_after({"password": "a-new-password"}).json["code"], "TOKEN_REVOKED")
        self.assertEqual(self.login("op@example.test", "a-new-password").status_code, 200)

    def test_deactivation_revokes_tokens(self):
        self._revoked_after({"is_active": False})

    def test_role_change_revokes_tokens(self):
        self._revoked_after({"role": "STAFF"})

    def test_revoking_sign_in_revokes_tokens(self):
        self._revoked_after({"role": "STAFF", "revoke_login": True})

    def test_profile_edit_does_not_sign_the_user_out(self):
        access = self.login("op@example.test").json["access_token"]
        self.client.patch(f"/api/users/{self.operator_id}", headers=self.auth(), json={"position": "Lead"})
        self.assertEqual(self.client.get("/api/auth/me", headers=bearer(access)).status_code, 200)


class KioskLockTests(AuthTestBase):
    def lock(self, email="admin@example.test"):
        access = self.login(email).json["access_token"]
        res = self.client.post("/api/auth/kiosk/lock", headers=bearer(access))
        self.assertEqual(res.status_code, 200, res.json)
        self.assertTrue(res.json["kiosk_locked"])
        return access, res.json["access_token"]

    def test_locked_session_only_reaches_the_kiosk_allowlist(self):
        _, kiosk = self.lock()
        for method, url in (("get", "/api/users"), ("get", "/api/attendance"), ("get", "/api/reports/today"),
                            ("get", "/api/review/snapshots"), ("post", "/api/auth/verify-password"),
                            ("get", "/api/enrollment/poses")):
            res = getattr(self.client, method)(url, headers=bearer(kiosk))
            self.assertEqual(res.status_code, 403, url)
            self.assertEqual(res.json["code"], "KIOSK_LOCKED", url)
        me = self.client.get("/api/auth/me", headers=bearer(kiosk))
        self.assertEqual(me.status_code, 200)
        self.assertTrue(me.json["kiosk_locked"])
        self.assertEqual(self.client.get("/api/meta", headers=bearer(kiosk)).status_code, 200)
        self.assertEqual(self.client.get("/api/recognition/kiosk-config", headers=bearer(kiosk)).status_code, 200)
        self.assertEqual(self.client.get(f"/api/users/{self.staff_id}/photo", headers=bearer(kiosk)).status_code, 404)

    def test_lock_revokes_the_unlocked_session_and_is_audited(self):
        portal, _ = self.lock()
        self.assertEqual(self.client.get("/api/users", headers=bearer(portal)).json["code"], "TOKEN_REVOKED")
        self.assertIn("KIOSK_LOCKED", self.audit_actions())

    def test_refresh_keeps_the_kiosk_claim(self):
        self.lock()
        res = self.refresh_with_cookie()
        self.assertEqual(res.status_code, 200, res.json)
        self.assertTrue(res.json["kiosk_locked"])
        self.assertEqual(self.client.get("/api/users", headers=bearer(res.json["access_token"])).json["code"],
                         "KIOSK_LOCKED")

    def test_kiosk_refresh_token_lives_longer(self):
        self.lock()
        claims = decode_token(self.cookie(REFRESH_COOKIE))
        self.assertGreater(claims["exp"] - claims["iat"], 29 * 86400)
        self.assertTrue(claims["kiosk"])

    def test_unlock_with_the_wrong_password_is_refused_and_audited(self):
        _, kiosk = self.lock()
        res = self.client.post("/api/auth/kiosk/unlock", headers=bearer(kiosk), json={"password": "nope-nope"})
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json["code"], "WRONG_PASSWORD")
        self.assertIn("KIOSK_UNLOCK_FAILED", self.audit_actions())
        self.assertEqual(self.client.get("/api/users", headers=bearer(kiosk)).json["code"], "KIOSK_LOCKED")

    def test_unlock_with_the_password_restores_the_portal(self):
        _, kiosk = self.lock()
        res = self.client.post("/api/auth/kiosk/unlock", headers=bearer(kiosk), json={"password": PASSWORD})
        self.assertEqual(res.status_code, 200, res.json)
        self.assertFalse(res.json["kiosk_locked"])
        self.assertEqual(self.client.get("/api/users", headers=bearer(res.json["access_token"])).status_code, 200)
        self.assertEqual(self.client.get("/api/auth/me", headers=bearer(kiosk)).status_code, 401)  # old one revoked
        self.assertFalse(decode_token(self.cookie(REFRESH_COOKIE))["kiosk"])
        self.assertIn("KIOSK_UNLOCKED", self.audit_actions())

    def test_unlock_is_rate_limited(self):
        _, kiosk = self.lock()
        for _ in range(5):
            self.client.post("/api/auth/kiosk/unlock", headers=bearer(kiosk), json={"password": "nope-nope"})
        res = self.client.post("/api/auth/kiosk/unlock", headers=bearer(kiosk), json={"password": PASSWORD})
        self.assertEqual(res.status_code, 429)
        self.assertEqual(res.json["code"], "RATE_LIMITED")
        self.assertIn("Retry-After", res.headers)

    def test_portal_session_cannot_check_in(self):
        res = self.client.post("/api/recognition/check-in", headers=self.auth(), content_type="multipart/form-data",
                               data={"frames": [(jpeg(), "f.jpg")]})
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json["code"], "KIOSK_REQUIRED")

    def test_staff_cannot_lock_or_check_in(self):
        self.assertEqual(self.client.post("/api/auth/kiosk/lock", headers=self.auth(self.staff_id)).status_code, 403)
        res = self.client.post("/api/recognition/check-in", headers=self.kiosk_auth(self.staff_id),
                               content_type="multipart/form-data", data={"frames": [(jpeg(), "f.jpg")]})
        self.assertEqual(res.status_code, 403)


class KioskRoleTests(AuthTestBase):
    NO_MATCH = {"status": "NO_MATCH", "score": 0.2, "reason": "Not recognised.", "snapshot_jpeg": b"x",
                "frames_with_face": 1, "elapsed_ms": 1}

    def test_kiosk_account_login_is_always_locked_and_cannot_unlock(self):
        res = self.login("lobby@example.test")
        self.assertEqual(res.status_code, 200, res.json)
        self.assertTrue(res.json["kiosk_locked"])
        kiosk = res.json["access_token"]
        self.assertEqual(self.client.get("/api/users", headers=bearer(kiosk)).json["code"], "KIOSK_LOCKED")
        unlock = self.client.post("/api/auth/kiosk/unlock", headers=bearer(kiosk), json={"password": PASSWORD})
        self.assertEqual(unlock.status_code, 403)
        self.assertTrue(self.refresh_with_cookie().json["kiosk_locked"])

    def test_kiosk_account_is_locked_even_with_a_token_that_says_otherwise(self):
        res = self.client.get("/api/users", headers=self.auth(self.kiosk_id, kiosk=False))
        self.assertEqual(res.json["code"], "KIOSK_LOCKED")

    def test_kiosk_device_id_is_the_account_not_the_client_value(self):
        with mock.patch("app.api.recognition_routes.recognize_burst", return_value=dict(self.NO_MATCH)), \
                mock.patch("app.api.recognition_routes.save_snapshot") as save:
            self.client.post("/api/recognition/check-in", headers=self.auth(self.kiosk_id),
                             content_type="multipart/form-data",
                             data={"frames": [(jpeg(), "f.jpg")], "device_id": "spoofed-device"})
        self.assertEqual(save.call_args.kwargs["device_id"], "kiosk:KIOSK-01")

    def test_admin_kiosk_device_id_is_prefixed_with_the_account(self):
        with mock.patch("app.api.recognition_routes.recognize_burst", return_value=dict(self.NO_MATCH)), \
                mock.patch("app.api.recognition_routes.save_snapshot") as save:
            self.client.post("/api/recognition/check-in", headers=self.kiosk_auth(),
                             content_type="multipart/form-data",
                             data={"frames": [(jpeg(), "f.jpg")], "device_id": "front-door"})
        self.assertEqual(save.call_args.kwargs["device_id"], "admin@example.test/front-door")

    def test_kiosk_accounts_need_a_password(self):
        res = self.client.post("/api/users", headers=self.auth(),
                               json={"full_name": "Tablet 2", "email": "t2@example.test", "role": "KIOSK"})
        self.assertEqual(res.status_code, 400)
        res = self.client.post("/api/users", headers=self.auth(), json={
            "full_name": "Tablet 2", "email": "t2@example.test", "role": "KIOSK", "password": "tablet-pass"})
        self.assertEqual(res.status_code, 201, res.json)
        self.assertEqual(res.json["role"], "KIOSK")

    def test_kiosk_accounts_cannot_be_enrolled(self):
        res = self.client.post("/api/enrollment/sample", headers=self.auth(), content_type="multipart/form-data",
                               data={"image": (jpeg(), "f.jpg"), "target_user_id": self.kiosk_id, "consent": "true"})
        self.assertEqual(res.status_code, 400)

    def test_kiosk_sessions_get_no_live_feed(self):
        kiosk = self.login("lobby@example.test").json["access_token"]
        locked_admin = self.kiosk_auth()["Authorization"][len("Bearer "):]
        portal = self.auth()["Authorization"][len("Bearer "):]
        for token, expected in ((kiosk, False), (locked_admin, False), (portal, True), ("garbage", False)):
            client = socketio.test_client(self.app, auth={"token": token})
            self.assertEqual(client.is_connected(), expected, token[:16])
            if expected:
                client.disconnect()
        # A revoked token is refused too.
        db.session.get(User, self.admin_id).revoke_tokens()
        db.session.commit()
        self.assertFalse(socketio.test_client(self.app, auth={"token": portal}).is_connected())


class RateLimitTests(AuthTestBase):
    def test_login_is_limited_per_ip(self):
        for i in range(10):
            self.login(email=f"x{i}@example.test", password="wrong-password")
        res = self.login()
        self.assertEqual(res.status_code, 429)
        self.assertEqual(res.json["code"], "RATE_LIMITED")
        self.assertGreaterEqual(res.json["retry_after"], 1)
        self.assertEqual(res.headers["Retry-After"], str(res.json["retry_after"]))

    def test_account_locks_after_repeated_failures_even_with_the_right_password(self):
        for _ in range(5):
            self.assertEqual(self.login(password="wrong-password").status_code, 401)
        res = self.login()
        self.assertEqual(res.status_code, 429)
        self.assertEqual(res.json["code"], "RATE_LIMITED")
        # Another account is unaffected.
        self.assertEqual(self.login("op@example.test").status_code, 200)

    def test_success_resets_the_failure_count(self):
        for _ in range(2):
            for _ in range(4):
                self.assertEqual(self.login(password="wrong-password").status_code, 401)
            self.assertEqual(self.login().status_code, 200)

    def test_lockout_is_case_insensitive(self):
        for _ in range(5):
            self.login(email="ADMIN@example.test", password="wrong-password")
        self.assertEqual(self.login().status_code, 429)

    def test_limits_can_be_disabled(self):
        self.app.config["RATE_LIMITS_ENABLED"] = False
        for _ in range(12):
            self.login(password="wrong-password")
        self.assertEqual(self.login().status_code, 200)

    def test_sliding_window_frees_slots_as_they_age(self):
        limiter = SlidingWindowLimiter()
        self.assertIsNone(limiter.hit("k", 2, 60, now=0))
        self.assertIsNone(limiter.hit("k", 2, 60, now=10))
        self.assertAlmostEqual(limiter.hit("k", 2, 60, now=20), 40)
        self.assertIsNone(limiter.hit("k", 2, 60, now=61))

    def test_lockout_expires(self):
        guard = LoginGuard()
        for t in range(3):
            guard.record_failure("a", 3, 900, now=t)
        self.assertIsNotNone(guard.retry_after("a", now=10))
        self.assertIsNone(guard.retry_after("a", now=903))


class UserAdminTests(AuthTestBase):
    def test_list_is_paginated_with_a_total_header(self):
        res = self.client.get("/api/users?limit=2&offset=1", headers=self.auth())
        self.assertEqual(res.status_code, 200)
        self.assertIsInstance(res.json, list)
        self.assertEqual(len(res.json), 2)
        self.assertEqual(res.headers["X-Total-Count"], "4")
        everyone = self.client.get("/api/users", headers=self.auth())
        self.assertEqual(len(everyone.json), 4)
        self.assertEqual(self.client.get("/api/users?limit=0", headers=self.auth()).status_code, 400)

    def test_user_with_attendance_is_archived_not_deleted(self):
        db.session.add(AttendanceEvent(user_id=self.staff_id, event_type="CLOCK_IN", match_score=0.9,
                                       match_status="MATCHED"))
        db.session.add(ScanSnapshot(user_id=self.staff_id, status="MATCHED", image=b"jpeg"))
        staff = db.session.get(User, self.staff_id)
        staff.photo = b"photo"
        db.session.commit()
        tv = staff.token_version

        res = self.client.delete(f"/api/users/{self.staff_id}", headers=self.auth())
        self.assertEqual(res.json, {"deleted": False, "archived": True, "id": self.staff_id})
        db.session.expire_all()
        staff = db.session.get(User, self.staff_id)
        self.assertFalse(staff.is_active)
        self.assertFalse(staff.can_login)
        self.assertIsNone(staff.photo)
        self.assertGreater(staff.token_version, tv)
        self.assertEqual(AttendanceEvent.query.filter_by(user_id=self.staff_id).count(), 1)
        self.assertEqual(FaceEmbedding.query.filter_by(user_id=self.staff_id).count(), 0)
        self.assertEqual(ScanSnapshot.query.filter_by(user_id=self.staff_id).count(), 0)
        self.assertIn("USER_ARCHIVED", self.audit_actions())

    def test_user_without_attendance_is_deleted(self):
        res = self.client.delete(f"/api/users/{self.staff_id}", headers=self.auth())
        self.assertEqual(res.json, {"deleted": True, "archived": False, "id": self.staff_id})
        self.assertIsNone(db.session.get(User, self.staff_id))
        self.assertIn("USER_DELETED", self.audit_actions())

    def test_orm_delete_never_cascades_into_attendance(self):
        db.session.add(AttendanceEvent(user_id=self.staff_id, event_type="CLOCK_IN", match_score=0.9,
                                       match_status="MATCHED"))
        db.session.commit()
        rel = User.attendance_events.property
        self.assertFalse(rel.cascade.delete)
        self.assertFalse(rel.cascade.delete_orphan)

    def test_updates_are_audited_without_password_values(self):
        res = self.client.patch(f"/api/users/{self.operator_id}", headers=self.auth(),
                                json={"position": "Lead", "password": "secret-new-pass", "role": "ADMIN"})
        self.assertEqual(res.status_code, 200, res.json)
        updated = AuditLog.query.filter_by(action="USER_UPDATED").one()
        details = json.loads(updated.details)
        self.assertEqual(details["fields"], ["position"])
        self.assertTrue(details["password_changed"])
        self.assertNotIn("secret-new-pass", updated.details)
        role = json.loads(AuditLog.query.filter_by(action="USER_ROLE_CHANGED").one().details)
        self.assertEqual(role, {"from": "OPERATOR", "to": "ADMIN"})

        self.client.patch(f"/api/users/{self.operator_id}", headers=self.auth(), json={"is_active": False})
        self.client.patch(f"/api/users/{self.operator_id}", headers=self.auth(), json={"is_active": True})
        actions = self.audit_actions()
        self.assertIn("USER_DEACTIVATED", actions)
        self.assertIn("USER_REACTIVATED", actions)

    def test_creation_is_audited_without_the_password(self):
        res = self.client.post("/api/users", headers=self.auth(), json={
            "full_name": "New Op", "email": "new@example.test", "role": "OPERATOR", "password": "op-password-1"})
        self.assertEqual(res.status_code, 201, res.json)
        created = AuditLog.query.filter_by(action="USER_CREATED").one()
        self.assertNotIn("op-password-1", created.details)

    def test_login_roles_cannot_lose_sign_in(self):
        res = self.client.patch(f"/api/users/{self.operator_id}", headers=self.auth(), json={"revoke_login": True})
        self.assertEqual(res.status_code, 400)
        self.assertTrue(db.session.get(User, self.operator_id).can_login)

    def test_overlong_password_is_rejected(self):
        res = self.client.patch(f"/api/users/{self.operator_id}", headers=self.auth(), json={"password": "x" * 73})
        self.assertEqual(res.status_code, 400)


class SpoofSnapshotTests(AuthTestBase):
    def test_spoof_snapshot_cannot_become_a_face_sample(self):
        snap = ScanSnapshot(user_id=self.staff_id, status="SPOOF_SUSPECTED", image=b"jpeg")
        db.session.add(snap)
        db.session.commit()
        with mock.patch("app.api.review_routes.enroll_sample") as enroll:
            res = self.client.post(f"/api/review/snapshots/{snap.id}/enroll", headers=self.auth(),
                                   json={"user_id": self.staff_id, "consent": True})
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json["code"], "SPOOF_SNAPSHOT")
        enroll.assert_not_called()

    def test_snapshot_cannot_be_added_twice(self):
        snap = ScanSnapshot(status="NO_MATCH", image=b"jpeg", resolution="ADDED")
        db.session.add(snap)
        db.session.commit()
        with mock.patch("app.api.review_routes.enroll_sample") as enroll:
            res = self.client.post(f"/api/review/snapshots/{snap.id}/enroll", headers=self.auth(),
                                   json={"user_id": self.staff_id})
        self.assertEqual(res.status_code, 409)
        enroll.assert_not_called()


if __name__ == "__main__":
    unittest.main()
