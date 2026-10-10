import os
import sqlite3
import sys
import tempfile
import unittest

from app import create_app
from app.config_check import InsecureConfigError, config_problems
from config import Config

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
sys.path.insert(0, TOOLS)

from cryptography.fernet import Fernet  # noqa: E402
import generate_secrets  # noqa: E402

GOOD = {
    "SECRET_KEY": "k" * 40,
    "JWT_SECRET_KEY": "j" * 40,
    "FACE_DATA_KEY": Fernet.generate_key().decode(),
    "SQLALCHEMY_DATABASE_URI": "postgresql://u:p@db/x",
}


class ConfigCheckTests(unittest.TestCase):
    def test_good_config_has_no_problems(self):
        self.assertEqual(config_problems(GOOD), [])

    def test_shipped_defaults_are_flagged(self):
        problems = " ".join(config_problems({
            "SECRET_KEY": "dev-secret-change-me-before-production-use",
            "JWT_SECRET_KEY": "dev-jwt-secret-change-me-before-production-use",
            "SQLALCHEMY_DATABASE_URI": "sqlite:///attendance.db",
        }))
        for expected in ("SECRET_KEY", "JWT_SECRET_KEY", "FACE_DATA_KEY", "SQLite"):
            self.assertIn(expected, problems)

    def test_short_identical_and_invalid_values_are_flagged(self):
        self.assertTrue(any("shorter" in p for p in config_problems({**GOOD, "SECRET_KEY": "short"})))
        self.assertTrue(any("different" in p for p in config_problems({**GOOD, "JWT_SECRET_KEY": GOOD["SECRET_KEY"]})))
        self.assertTrue(any("valid Fernet key" in p for p in config_problems({**GOOD, "FACE_DATA_KEY": "not-a-key"})))

    def test_production_refuses_unsafe_config(self):
        class Unsafe(Config):
            APP_ENV = "production"
            FACE_DATA_KEY = None
            SQLALCHEMY_DATABASE_URI = "sqlite://"
        with self.assertRaises(InsecureConfigError) as ctx:
            create_app(Unsafe)
        self.assertIn("FACE_DATA_KEY", str(ctx.exception))

    def test_production_starts_with_safe_config(self):
        class Safe(Config):
            APP_ENV = "production"
            SECRET_KEY, JWT_SECRET_KEY, FACE_DATA_KEY = GOOD["SECRET_KEY"], GOOD["JWT_SECRET_KEY"], GOOD["FACE_DATA_KEY"]
            SQLALCHEMY_DATABASE_URI = "sqlite://"   # in-memory so the test needs no server
        # The SQLite problem is the only one left, and it is the one we expect.
        with self.assertRaises(InsecureConfigError) as ctx:
            create_app(Safe)
        self.assertIn("SQLite", str(ctx.exception))
        self.assertNotIn("SECRET_KEY", str(ctx.exception))

    def test_development_only_warns(self):
        class Dev(Config):
            APP_ENV = "testing"
            TESTING = True
            SQLALCHEMY_DATABASE_URI = "sqlite://"
        create_app(Dev)  # must not raise


class GenerateSecretsTests(unittest.TestCase):
    def test_generated_values_pass_the_production_check(self):
        v = generate_secrets.generate()
        cfg = {"SECRET_KEY": v["secret_key"], "JWT_SECRET_KEY": v["jwt_key"], "FACE_DATA_KEY": v["face_key"],
               "SQLALCHEMY_DATABASE_URI": f"postgresql://attendance:{v['db_password']}@db/attendance"}
        self.assertEqual(config_problems(cfg), [])
        self.assertNotEqual(v["secret_key"], v["jwt_key"])

    def test_values_are_unique_per_run(self):
        self.assertNotEqual(generate_secrets.generate()["face_key"], generate_secrets.generate()["face_key"])

    def test_template_renders_every_placeholder(self):
        rendered = generate_secrets.TEMPLATE.format(**generate_secrets.generate())
        self.assertNotIn("{", rendered)
        self.assertIn("APP_ENV=production", rendered)


class MigrationTests(unittest.TestCase):
    def test_copies_every_row_and_refuses_a_non_empty_target(self):
        import migrate_to_postgres
        from app.extensions import db
        from app.models.face_embedding import FaceEmbedding
        from app.models.user import User

        with tempfile.TemporaryDirectory() as tmp:
            src, dst = os.path.join(tmp, "src.db"), os.path.join(tmp, "dst.db")

            class SrcConfig(Config):
                APP_ENV = "testing"
                TESTING = True
                SQLALCHEMY_DATABASE_URI = f"sqlite:///{src}"

            app = create_app(SrcConfig)
            with app.app_context():
                u = User(full_name="Juan", email="juan@example.test", password_hash="x", employee_code="EMP-0001", photo=b"\xff\xd8")
                db.session.add(u)
                db.session.flush()
                e = FaceEmbedding(user_id=u.id, pose_label="frontal", model="sface")
                e.vector = [0.1, 0.2, 0.3]
                db.session.add(e)
                db.session.commit()
                user_id = u.id
                db.session.remove()
                db.engine.dispose()

            counts = migrate_to_postgres.migrate(f"sqlite:///{src}", f"sqlite:///{dst}")
            self.assertEqual(counts["users"], 1)
            self.assertEqual(counts["face_embeddings"], 1)
            conn = sqlite3.connect(dst)
            try:
                self.assertEqual(conn.execute("select id, employee_code from users").fetchone(), (user_id, "EMP-0001"))
                self.assertEqual(conn.execute("select count(*) from face_embeddings").fetchone()[0], 1)
            finally:
                conn.close()   # sqlite3's context manager commits but does not close; Windows then can't delete the file

            with self.assertRaises(SystemExit):
                migrate_to_postgres.migrate(f"sqlite:///{src}", f"sqlite:///{dst}")


if __name__ == "__main__":
    unittest.main()
