import os
from datetime import timedelta

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:  # python-dotenv is optional
    pass


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _float_or_none(name: str):
    value = os.environ.get(name)
    return float(value) if value not in (None, "") else None


class Config:
    """
    Central configuration. All values are overridable via environment
    variables so the same codebase runs in dev (SQLite) and production
    (Postgres via Docker Compose) without code changes.
    """
    # "production" makes unsafe settings (placeholder secrets, no FACE_DATA_KEY,
    # SQLite) a startup error instead of a warning. See app/config_check.py.
    APP_ENV = os.environ.get("APP_ENV", "development").strip().lower()
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me-before-production-use")
    JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "dev-jwt-secret-change-me-before-production-use")
    # Access tokens live only in browser memory and are short; the refresh
    # token is an httpOnly cookie scoped to /api/auth, so page scripts (and
    # therefore XSS) can never read it.
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(minutes=int(os.environ.get("JWT_ACCESS_MINUTES", 30)))
    JWT_REFRESH_TOKEN_EXPIRES = timedelta(days=int(os.environ.get("JWT_REFRESH_DAYS", 7)))
    # Kiosk devices stay signed in longer so a tablet isn't logged out weekly.
    KIOSK_REFRESH_DAYS = int(os.environ.get("KIOSK_REFRESH_DAYS", 30))
    JWT_TOKEN_LOCATION = ["headers", "cookies"]
    JWT_REFRESH_COOKIE_PATH = "/api/auth"
    # Access tokens are never put in cookies; this path matches nothing.
    JWT_ACCESS_COOKIE_PATH = "/api/__no_access_cookie__"
    JWT_COOKIE_SECURE = _bool("JWT_COOKIE_SECURE", APP_ENV == "production")
    JWT_COOKIE_SAMESITE = "Strict"
    JWT_COOKIE_CSRF_PROTECT = True
    JWT_CSRF_IN_COOKIES = True
    JWT_REFRESH_CSRF_COOKIE_PATH = "/"

    # Number of reverse proxies in front of the app (Caddy in docker-compose
    # = 1). Needed so rate limits and logs see the real client IP.
    TRUST_PROXY_HOPS = int(os.environ.get("TRUST_PROXY_HOPS", 0))

    # Rate limits (in-memory; the app runs as a single worker).
    RATE_LIMITS_ENABLED = _bool("RATE_LIMITS_ENABLED", True)
    # Failed sign-ins per email before that account is locked out for
    # LOGIN_LOCKOUT_MINUTES (per-IP limits apply on top).
    LOGIN_MAX_FAILURES = int(os.environ.get("LOGIN_MAX_FAILURES", 5))
    LOGIN_LOCKOUT_MINUTES = int(os.environ.get("LOGIN_LOCKOUT_MINUTES", 15))

    # db.create_all() + the legacy column updater at startup. Convenient in
    # development; production runs Alembic migrations (manage_db.py) instead.
    AUTO_CREATE_SCHEMA = _bool("AUTO_CREATE_SCHEMA", APP_ENV != "production")

    # Default to SQLite for zero-setup local dev. Swap DATABASE_URL to a
    # postgres:// URI (see docker-compose.yml) for the production stack.
    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL", "sqlite:///attendance.db")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    CORS_ORIGINS = [origin.strip() for origin in os.environ.get(
        "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",") if origin.strip()]
    # Employees are added by an admin on the Enroll page; public sign-up is off.
    ALLOW_PUBLIC_REGISTRATION = _bool("ALLOW_PUBLIC_REGISTRATION", False)
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # a kiosk burst is ~10 small JPEGs

    # --- Face recognition tuning ---
    # "auto" uses OpenCV YuNet+SFace when backend/models has the ONNX files
    # (fast, most accurate), otherwise dlib. See app/vision/engines.py.
    FACE_ENGINE = os.environ.get("FACE_ENGINE", "auto")
    # Thresholds are cosine similarity and differ per engine, so they
    # default to the engine's calibrated values (engines.py DEFAULTS).
    # Set any of these env vars only after testing on your own cameras.
    FACE_MATCH_THRESHOLD = _float_or_none("FACE_MATCH_THRESHOLD")
    FACE_AMBIGUITY_MARGIN = _float_or_none("FACE_AMBIGUITY_MARGIN")
    # New enrollment samples must resemble the employee's earlier samples
    # (wrong person stepping in) and must not resemble another employee
    # (one person enrolled under two identities).
    ENROLL_CONSISTENCY_THRESHOLD = _float_or_none("ENROLL_CONSISTENCY_THRESHOLD")
    ENROLL_DUPLICATE_THRESHOLD = _float_or_none("ENROLL_DUPLICATE_THRESHOLD")
    # Extra passes per enrollment embedding (SFace: mirrored and
    # brightness-shifted crops, up to 6 variants; dlib: random re-crops).
    # Enrollment is one-off, so the extra cost is fine.
    ENROLL_NUM_JITTERS = int(os.environ.get("ENROLL_NUM_JITTERS", 5))
    # Sharpness floor (Laplacian variance of the face crop) for enrollment
    # samples only; the kiosk keeps the looser quality.BLUR_THRESHOLD so a
    # scan isn't refused while autofocus catches up. 60 over-rejected
    # ordinary webcams, so start here and raise it if enrolled samples
    # still look soft.
    ENROLL_BLUR_THRESHOLD = float(os.environ.get("ENROLL_BLUR_THRESHOLD", 45))
    # Minimum samples required to finish enrolling a face.
    MIN_ENROLLMENT_SAMPLES = int(os.environ.get("MIN_ENROLLMENT_SAMPLES", 5))
    MAX_ENROLLMENT_SAMPLES = int(os.environ.get("MAX_ENROLLMENT_SAMPLES", 12))

    # Detection runs on a downscaled copy (at most this width, px) and the
    # box is mapped back to full resolution for landmarks/embedding.
    DETECTION_WIDTH = int(os.environ.get("DETECTION_WIDTH", 480))
    # How many frames of a kiosk burst get a full embedding (the sharpest
    # ones). Every frame still gets landmarks for liveness.
    RECOGNITION_MAX_EMBED_FRAMES = int(os.environ.get("RECOGNITION_MAX_EMBED_FRAMES", 3))
    # Fraction of embedded frames that must individually agree on the
    # same person before a match is accepted.
    RECOGNITION_MIN_VOTE_RATIO = float(os.environ.get("RECOGNITION_MIN_VOTE_RATIO", 0.6))

    # Seconds a user must wait between two attendance events (prevents
    # duplicate clock-ins from repeated camera frames/accidental re-scans).
    ATTENDANCE_COOLDOWN_SECONDS = int(os.environ.get("ATTENDANCE_COOLDOWN_SECONDS", 3))
    # How long after a punch a re-scan only *re-verifies* it instead of
    # starting the next punch. This is the window in which an employee can
    # scan again to reassure themselves their time in registered, and it is
    # also what stops that reassurance scan from being written as a time
    # out. Past the window, duplicates are still refused per punch — each
    # of the six (AM/PM/OT x in/out) is a once-a-day slot. See
    # AlreadyVerified in attendance_service.py.
    ATTENDANCE_REVERIFY_WINDOW_SECONDS = int(os.environ.get("ATTENDANCE_REVERIFY_WINDOW_SECONDS", 120))
    # Organizational timezone used to decide what "today" is.
    ORG_TIMEZONE = os.environ.get("ORG_TIMEZONE", "Asia/Manila")
    # Shift start (HH:MM, org timezone) — clock-ins after this + grace are "late".
    SHIFT_START = os.environ.get("SHIFT_START", "08:00")
    # Shift end (HH:MM, org timezone) used for any department that hasn't
    # configured its own end_time. Once it passes, a kiosk scan is always a
    # time out — an employee who has already worked today cannot time in
    # again on the regular shift, they have to pick OT In. Set empty to
    # disable the rule for unconfigured departments.
    SHIFT_END = os.environ.get("SHIFT_END", "17:00")
    LATE_GRACE_MINUTES = int(os.environ.get("LATE_GRACE_MINUTES", 15))
    # Default lunch break window (HH:MM, org timezone) used for any
    # department that hasn't configured its own break_start/break_end.
    # Time inside this window is excluded from worked-hours totals.
    BREAK_START = os.environ.get("BREAK_START", "12:00")
    BREAK_END = os.environ.get("BREAK_END", "13:00")

    # --- Lighting normalisation ---
    # CLAHE on the luminance channel, applied before embedding only when a
    # face is low-contrast or unevenly lit (see app/vision/enhance.py).
    CLAHE_ENABLED = _bool("CLAHE_ENABLED", True)

    # --- Passive anti-spoofing (see app/vision/antispoof.py) ---
    # off | log | enforce | auto. auto = enforce when the MiniFASNet ONNX
    # models are in backend/models, otherwise log only (the built-in
    # heuristic is too weak to block real people with).
    SPOOF_MODE = os.environ.get("SPOOF_MODE", "auto").strip().lower()
    SPOOF_THRESHOLD = _float_or_none("SPOOF_THRESHOLD")

    # --- Check-in snapshots / review queue ---
    SNAPSHOTS_ENABLED = _bool("SNAPSHOTS_ENABLED", True)
    SNAPSHOT_RETENTION_DAYS = int(os.environ.get("SNAPSHOT_RETENTION_DAYS", 90))
    SNAPSHOT_UNMATCHED_RETENTION_DAYS = int(os.environ.get("SNAPSHOT_UNMATCHED_RETENTION_DAYS", 30))
    # At most one unmatched snapshot per device+status in this many seconds,
    # so a stranger standing at the kiosk doesn't flood the review queue.
    SNAPSHOT_THROTTLE_SECONDS = int(os.environ.get("SNAPSHOT_THROTTLE_SECONDS", 10))

    # --- Biometric data protection ---
    # Fernet key (urlsafe base64, 32 bytes). When set, face embeddings,
    # profile photos and scan snapshots are encrypted at rest. Generate with:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # Losing the key makes encrypted data unrecoverable — back it up.
    FACE_DATA_KEY = os.environ.get("FACE_DATA_KEY") or None
    # Run recognition in a native thread under eventlet so a ~300ms scan
    # doesn't stall Socket.IO and other requests.
    OFFLOAD_RECOGNITION = _bool("OFFLOAD_RECOGNITION", True)

    # --- Logging ---
    LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
    LOG_DIR = os.environ.get("LOG_DIR") or os.path.join(os.path.dirname(__file__), "logs")

    # Work days. Overnight schedules start their work day this many hours
    # before the shift start (22:00 shift -> 16:00..16:00), so a 06:00 time
    # out pairs with the previous evening's time in.
    WORKDAY_ROLLOVER_BUFFER_HOURS = float(os.environ.get("WORKDAY_ROLLOVER_BUFFER_HOURS", 6))
    # Rotating shifts: a clock-in matches the shift whose start is nearest,
    # within this many hours; otherwise no schedule applies (never late).
    SHIFT_MATCH_WINDOW_HOURS = float(os.environ.get("SHIFT_MATCH_WINDOW_HOURS", 4))

    # Liveness (blink detection).
    LIVENESS_REQUIRED = _bool("LIVENESS_REQUIRED", True)
    LIVENESS_EAR_BLINK_DELTA = float(os.environ.get("LIVENESS_EAR_BLINK_DELTA", 0.06))
    # EAR samples from consecutive scans of the same person on the same
    # device are pooled for this many seconds, so a blink in any recent
    # scan counts and the kiosk does not make people start over.
    LIVENESS_WINDOW_SECONDS = float(os.environ.get("LIVENESS_WINDOW_SECONDS", 8))
    # Re-embed the closed-eye frame and require it to match the recognised
    # person, so a photo of A can't borrow the blink of a live face B.
    LIVENESS_VERIFY_BLINK_FRAME = _bool("LIVENESS_VERIFY_BLINK_FRAME", True)
    # Minimum box overlap between consecutive frames to count as the same face.
    LIVENESS_TRACK_MIN_IOU = float(os.environ.get("LIVENESS_TRACK_MIN_IOU", 0.3))
    # Eye-landmark source for blink detection. The default dlib 68-point
    # model is trained on iBUG 300-W (non-commercial licence terms).
    LIVENESS_LANDMARK_MODEL = os.environ.get("LIVENESS_LANDMARK_MODEL", "dlib68")
    # Passive anti-spoof scores this many frames and keeps the worst score.
    SPOOF_CHECK_FRAMES = int(os.environ.get("SPOOF_CHECK_FRAMES", 3))


CONFIG = Config
