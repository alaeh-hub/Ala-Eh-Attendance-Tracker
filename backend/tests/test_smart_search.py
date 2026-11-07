"""Smart search: the engine itself, and the endpoints that use it. Mirrors frontend/src/utils/search.test.ts."""
import unittest

from app.utils.search import fold, score, smart_filter


def match(query, *fields):
    return score(query, fields)[0] > 0


class EngineTests(unittest.TestCase):
    JUAN = ("Juan Dela Cruz", "juan@example.test", "EMP-0007", "HR", None)

    def test_empty_query_matches_everything(self):
        self.assertTrue(match("", *self.JUAN))
        self.assertTrue(match("   ", *self.JUAN))

    def test_words_across_fields_in_any_order(self):
        self.assertTrue(match("juan hr", *self.JUAN))
        self.assertTrue(match("hr juan", *self.JUAN))
        self.assertTrue(match("emp-0007 cruz", *self.JUAN))

    def test_every_word_must_match(self):
        self.assertFalse(match("juan finance", *self.JUAN))
        self.assertFalse(match("cruzemp", *self.JUAN))

    def test_accents_case_and_punctuation(self):
        self.assertTrue(match("jose nunez", "José Núñez"))
        self.assertTrue(match("JOSÉ", "Jose Santos"))
        self.assertTrue(match("emp 0007", "EMP-0007"))
        self.assertTrue(match("emp0007", "EMP-0007"))

    def test_word_start_inside_word_and_joined_names(self):
        self.assertTrue(match("hum res", "Human Resources"))
        self.assertTrue(match("ources", "Human Resources"))
        self.assertTrue(match("delacruz", "Juan Dela Cruz"))

    def test_typos(self):
        self.assertTrue(match("jaun", "Juan Dela Cruz"))
        self.assertTrue(match("resorces", "Human Resources"))
        self.assertTrue(match("jaunit", "Juanito Reyes"))
        self.assertFalse(match("jin", "Juan"))
        self.assertFalse(match("zebra", "Juan Dela Cruz", "HR"))

    def test_digits_are_never_fuzzed(self):
        self.assertFalse(match("emp-0008", "EMP-0007"))
        self.assertTrue(match("0007", "EMP-0007"))

    def test_fold_keeps_length(self):
        for text in ("José Núñez", "EMP-0007", "İstanbul", "Zoë"):
            self.assertEqual(len(fold(text)), len(text))

    def test_ranking_and_typo_fallback(self):
        names = ["Marion", "Mario", "Marlo"]
        self.assertEqual(smart_filter(names, "mario", lambda s: (s,)), ["Mario", "Marion"])
        self.assertEqual(smart_filter(["Maria Santos", "Mario Santiago"], "mario", lambda s: (s,), rank=False), ["Mario Santiago"])
        self.assertEqual(smart_filter(["Juan Cruz", "Pedro Reyes"], "jaun", lambda s: (s,)), ["Juan Cruz"])

    def test_empty_query_returns_everything_in_order(self):
        self.assertEqual(smart_filter(["b", "a"], "", lambda s: (s,)), ["b", "a"])


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------- endpoint
from flask_jwt_extended import create_access_token  # noqa: E402

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402
from app.models.user import User  # noqa: E402
from config import Config  # noqa: E402


class _Cfg(Config):
    APP_ENV = "testing"
    SQLALCHEMY_DATABASE_URI = "sqlite://"
    TESTING = True
    RATE_LIMITS_ENABLED = False


class UserSearchEndpointTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app(_Cfg)
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.client = self.app.test_client()
        hash_ = "$2b$12$" + "x" * 53
        admin = User(full_name="Admin", email="admin@example.test", password_hash=hash_, role="ADMIN")
        db.session.add(admin)
        for i, (name, dept) in enumerate([
            ("José Núñez", "Human Resources"), ("Juan Dela Cruz", "Kitchen"), ("Maria Santos", "Kitchen"),
            ("Mario Santiago", "Packaging"), ("Ana Reyes", "Human Resources"),
        ]):
            db.session.add(User(full_name=name, email=f"user{i}@example.test", employee_code=f"EMP-{i + 1:04d}",
                                department=dept, password_hash=hash_, role="STAFF"))
        db.session.commit()
        self.headers = {"Authorization": f"Bearer {create_access_token(identity=admin.id)}"}

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def search(self, q, **extra):
        res = self.client.get("/api/users", headers=self.headers, query_string={"q": q, **extra})
        self.assertEqual(res.status_code, 200)
        return [u["full_name"] for u in res.get_json()], int(res.headers["X-Total-Count"])

    def test_words_may_span_fields(self):
        self.assertEqual(self.search("juan kitchen")[0], ["Juan Dela Cruz"])

    def test_accents_and_typos(self):
        self.assertEqual(self.search("jose nunez")[0], ["José Núñez"])
        self.assertEqual(self.search("jaun")[0], ["Juan Dela Cruz"])

    def test_best_match_first_and_typos_are_a_fallback(self):
        self.assertEqual(self.search("mario")[0], ["Mario Santiago"])

    def test_employee_codes_are_exact(self):
        self.assertEqual(self.search("emp-0002")[0], ["Juan Dela Cruz"])
        self.assertEqual(self.search("emp-0099")[0], [])

    def test_total_and_paging_follow_the_matches(self):
        names, total = self.search("human resources", limit=1)
        self.assertEqual((len(names), total), (1, 2))
        names2, _ = self.search("human resources", limit=1, offset=1)
        self.assertEqual(sorted(names + names2), ["Ana Reyes", "José Núñez"])

    def test_filters_still_apply_alongside_a_search(self):
        self.assertEqual(self.search("santos", department="Packaging")[0], [])

    def test_no_search_is_unchanged(self):
        res = self.client.get("/api/users", headers=self.headers)
        self.assertEqual(len(res.get_json()), 6)
