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
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(hours=12)
    JWT_REFRESH_TOKEN_EXPIRES = timedelta(days=7)

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

    # Liveness (blink detection).
    LIVENESS_REQUIRED = _bool("LIVENESS_REQUIRED", True)
    LIVENESS_EAR_BLINK_DELTA = float(os.environ.get("LIVENESS_EAR_BLINK_DELTA", 0.06))
    # EAR samples from consecutive scans of the same person on the same
    # device are pooled for this many seconds, so a blink in any recent
    # scan counts and the kiosk does not make people start over.
    LIVENESS_WINDOW_SECONDS = float(os.environ.get("LIVENESS_WINDOW_SECONDS", 8))


CONFIG = Config
