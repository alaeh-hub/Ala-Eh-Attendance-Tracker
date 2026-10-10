"""
Startup safety checks for secrets, biometric encryption and the database.

APP_ENV=production turns every problem into a startup failure, so the app
can't quietly run with the placeholder secrets that ship in config.py or
with face data stored in plaintext. In development the same problems are
logged as warnings.
"""
import logging

logger = logging.getLogger("app.config")

MIN_SECRET_LENGTH = 32
PLACEHOLDER_MARKERS = ("change-me", "dev-secret", "dev-jwt", "changeme", "example", "your-")


class InsecureConfigError(RuntimeError):
    pass


def _weak_secret(value) -> bool:
    if not value or len(value) < MIN_SECRET_LENGTH:
        return True
    lowered = value.lower()
    return any(marker in lowered for marker in PLACEHOLDER_MARKERS)


def _valid_fernet_key(key: str) -> bool:
    try:
        from cryptography.fernet import Fernet
        Fernet(key.encode())
        return True
    except Exception:  # noqa: BLE001 - any parse failure means "not a valid key"
        return False


def config_problems(cfg) -> list[str]:
    """Human-readable list of what is unsafe about this configuration (empty = fine)."""
    problems = []
    if _weak_secret(cfg.get("SECRET_KEY")):
        problems.append(f"SECRET_KEY is missing, a placeholder, or shorter than {MIN_SECRET_LENGTH} characters.")
    if _weak_secret(cfg.get("JWT_SECRET_KEY")):
        problems.append(f"JWT_SECRET_KEY is missing, a placeholder, or shorter than {MIN_SECRET_LENGTH} characters.")
    if cfg.get("SECRET_KEY") and cfg.get("SECRET_KEY") == cfg.get("JWT_SECRET_KEY"):
        problems.append("SECRET_KEY and JWT_SECRET_KEY must be different values.")

    key = cfg.get("FACE_DATA_KEY")
    if not key:
        problems.append("FACE_DATA_KEY is not set, so face embeddings, photos and snapshots are stored unencrypted.")
    elif not _valid_fernet_key(key):
        problems.append("FACE_DATA_KEY is not a valid Fernet key (urlsafe base64, 32 bytes).")

    if str(cfg.get("SQLALCHEMY_DATABASE_URI", "")).startswith("sqlite"):
        problems.append("DATABASE_URL points at SQLite. Use PostgreSQL in production.")
    return problems


def enforce(app) -> None:
    """Raise in production, warn elsewhere."""
    problems = config_problems(app.config)
    if not problems:
        return
    if app.config.get("APP_ENV") == "production":
        raise InsecureConfigError(
            "Refusing to start in production with an unsafe configuration:\n  - " + "\n  - ".join(problems)
            + "\nRun `python tools/generate_secrets.py` for fresh values."
        )
    if not app.testing:
        for problem in problems:
            logger.warning("config (development): %s", problem)
