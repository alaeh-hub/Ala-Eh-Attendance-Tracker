"""Clear all data: wipes company data, keeps administrators and departments."""
import os
import sys
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from flask import g  # noqa: E402

from app.extensions import db  # noqa: E402
from app.models.attendance_event import AttendanceEvent  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.department import Department  # noqa: E402
from app.models.face_embedding import FaceEmbedding  # noqa: E402
from app.models.scan_snapshot import ScanSnapshot  # noqa: E402
from app.models.user import User  # noqa: E402
from test_recognition_routes import TEST_PASSWORD_HASH, BaseAppTest  # noqa: E402


class ClearAllDataTests(BaseAppTest):
    def setUp(self):
        super().setUp()
        # BaseAppTest gives us an admin (with a face sample) and Juan, a staff member with 3 samples.
        db.session.add(Department(name="Production"))
        operator = User(full_name="Kiosk Operator", email="op@example.test", password_hash=TEST_PASSWORD_HASH, role="OPERATOR")
        db.session.add(operator)
        db.session.flush()
        self.operator_id = operator.id
        admin = db.session.get(User, self.admin_id)
        admin.photo = b"photo"
        admin.biometric_consent_at = datetime.utcnow()
        event = AttendanceEvent(user_id=self.staff_id, event_type="CLOCK_IN", match_score=0.9, match_status="MATCHED")
        db.session.add(event)
        db.session.flush()
        db.session.add_all([
            AttendanceEvent(user_id=self.admin_id, event_type="CLOCK_IN", match_score=0.9, match_status="MATCHED"),
            ScanSnapshot(user_id=self.staff_id, event_id=event.id, status="MATCHED", image=b"jpeg"),
            ScanSnapshot(status="NO_MATCH", image=b"jpeg"),
            AuditLog(actor_user_id=self.admin_id, action="USER_CREATED"),
        ])
        db.session.commit()

    def _clear(self, **body):
        body.setdefault("confirm", "DELETE")
        body.setdefault("password", "test-password")
        return self.client.post("/api/admin/clear-all-data", headers=self.auth(), json=body)

    def test_wipes_company_data_but_keeps_admins_and_departments(self):
        res = self._clear()
        self.assertEqual(res.status_code, 200, res.json)
        self.assertEqual(res.json["users_removed"], 1)          # Juan
        self.assertEqual(res.json["face_samples"], 4)           # Juan's 3 + the admin's 1
        self.assertEqual(res.json["review_snapshots"], 2)
        self.assertEqual(res.json["attendance_events"], 2)

        self.assertEqual(ScanSnapshot.query.count(), 0)
        self.assertEqual(AttendanceEvent.query.count(), 0)
        self.assertEqual(FaceEmbedding.query.count(), 0)
        self.assertIsNone(db.session.get(User, self.staff_id))
        # Kept: the administrator (without face-derived data), the operator, and the department.
        admin = db.session.get(User, self.admin_id)
        self.assertIsNotNone(admin)
        self.assertIsNone(admin.photo)
        self.assertIsNone(admin.biometric_consent_at)
        self.assertIsNotNone(db.session.get(User, self.operator_id))
        self.assertEqual(Department.query.count(), 1)
        self.assertEqual(res.json["kept"], {"admins": 1, "operators": 1, "kiosks": 0, "departments": 1})

    def test_audit_history_is_kept_and_the_reset_itself_is_recorded(self):
        res = self._clear()
        self.assertNotIn("audit_entries", res.json)
        actions = [e.action for e in AuditLog.query.order_by(AuditLog.created_at).all()]
        self.assertIn("USER_CREATED", actions)   # history from before the reset survives
        reset = AuditLog.query.filter_by(action="ALL_DATA_CLEARED").one()
        self.assertEqual(reset.actor_user_id, self.admin_id)

    def test_operators_can_be_removed_too_on_request(self):
        res = self._clear(keep_operators=False)
        self.assertEqual(res.json["users_removed"], 2)
        self.assertIsNone(db.session.get(User, self.operator_id))
        self.assertIsNotNone(db.session.get(User, self.admin_id))

    def test_admin_can_still_sign_in_afterwards(self):
        self._clear()
        login = self.client.post("/api/auth/login", json={"email": "admin@example.test", "password": "test-password"})
        self.assertEqual(login.status_code, 200)

    def test_wrong_password_deletes_nothing(self):
        res = self._clear(password="wrong")
        self.assertEqual(res.status_code, 403)          # 403, so the web app does not treat it as an expired session
        self.assertEqual(User.query.count(), 3)
        self.assertEqual(AttendanceEvent.query.count(), 2)

    def test_missing_confirmation_deletes_nothing(self):
        for body in ({"confirm": "delete"}, {"confirm": ""}, {"confirm": None}):
            res = self._clear(**body)
            self.assertEqual(res.status_code, 400, body)
        res = self.client.post("/api/admin/clear-all-data", headers=self.auth(), json={"password": "test-password"})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(User.query.count(), 3)
        self.assertEqual(FaceEmbedding.query.count(), 4)

    def test_only_administrators_may_clear(self):
        for user_id in (self.staff_id, self.operator_id):
            g.pop("current_user", None)  # the tests share one app context, which caches the caller
            res = self.client.post("/api/admin/clear-all-data", headers=self.auth(user_id), json={"confirm": "DELETE", "password": "test-password"})
            self.assertEqual(res.status_code, 403)
        g.pop("current_user", None)
        self.assertEqual(self.client.post("/api/admin/clear-all-data", json={}).status_code, 401)
        self.assertEqual(User.query.count(), 3)

    def test_non_json_body_is_a_clean_error(self):
        res = self.client.post("/api/admin/clear-all-data", headers=self.auth(), data="nope", content_type="text/plain")
        self.assertEqual(res.status_code, 400)


if __name__ == "__main__":
    unittest.main()
