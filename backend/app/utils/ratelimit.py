"""
In-memory rate limiting and sign-in lockout.

State lives in this process's memory. That is correct for the deployment
this app ships with (ONE gunicorn worker, required anyway by Flask-SocketIO
without a message queue), but each extra worker or replica would get its
own counters, multiplying the effective limits. Move the store to Redis
before scaling out.

Two mechanisms:
- `rate_limit(...)` / `check_rate(...)`: a sliding-window cap on requests
  per key (client IP and/or user) — every attempt counts.
- `login_guard`: per-email lockout that counts only FAILED sign-ins and
  is cleared by a successful one.

Exceeding either raises `RateLimited`, rendered as
`429 {error, code: "RATE_LIMITED", retry_after}` plus a `Retry-After` header.
"""
import math
import threading
import time
from collections import deque
from functools import wraps

from flask import current_app, jsonify, request

from app.middleware.error_handler import AppError


class RateLimited(AppError):
    def __init__(self, retry_after: float, message: str | None = None):
        seconds = max(1, int(math.ceil(retry_after)))
        super().__init__(message or f"Too many attempts. Try again in {seconds} seconds.", 429,
                         {"code": "RATE_LIMITED", "retry_after": seconds})
        self.retry_after = seconds


def rate_limited_response(err: RateLimited):
    """Error handler for RateLimited (registered app-wide by the auth blueprint)."""
    from app.extensions import db
    db.session.rollback()
    response = jsonify({"error": err.message, **err.payload})
    response.status_code = 429
    response.headers["Retry-After"] = str(err.retry_after)
    return response


def _enabled() -> bool:
    return bool(current_app.config.get("RATE_LIMITS_ENABLED", True))


def client_ip() -> str:
    # ProxyFix (TRUST_PROXY_HOPS) has already replaced remote_addr with the
    # real client address when the app runs behind Caddy.
    return request.remote_addr or "unknown"


class SlidingWindowLimiter:
    """Thread-safe sliding-window counter: at most `limit` hits per `window` seconds per key."""

    _SWEEP_EVERY = 1000  # hits between sweeps of idle keys, so memory stays bounded

    def __init__(self):
        self._lock = threading.Lock()
        self._hits: dict[str, deque] = {}
        self._since_sweep = 0

    def hit(self, key: str, limit: int, window: float, now: float | None = None) -> float | None:
        """Record a hit. Returns None when allowed, else seconds until a slot frees up
        (a refused hit is not recorded, so hammering does not extend the wait)."""
        now = time.monotonic() if now is None else now
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and hits[0] <= now - window:
                hits.popleft()
            if len(hits) >= limit:
                return hits[0] + window - now
            hits.append(now)
            self._maybe_sweep(now, window)
            return None

    def _maybe_sweep(self, now: float, window: float):
        self._since_sweep += 1
        if self._since_sweep < self._SWEEP_EVERY:
            return
        self._since_sweep = 0
        # Windows differ per key; an hour covers every limit used here.
        horizon = now - max(window, 3600)
        for key in [k for k, d in self._hits.items() if not d or d[-1] <= horizon]:
            del self._hits[key]

    def reset(self):
        with self._lock:
            self._hits.clear()
            self._since_sweep = 0


class LoginGuard:
    """Per-account lockout: `max_failures` failed sign-ins within `lockout`
    seconds lock the account for `lockout` seconds. Only failures count, and
    a successful sign-in clears the record."""

    def __init__(self):
        self._lock = threading.Lock()
        self._failures: dict[str, deque] = {}
        self._locked_until: dict[str, float] = {}

    def retry_after(self, key: str, now: float | None = None) -> float | None:
        now = time.monotonic() if now is None else now
        with self._lock:
            until = self._locked_until.get(key)
            if until is None:
                return None
            if until <= now:
                del self._locked_until[key]
                return None
            return until - now

    def record_failure(self, key: str, max_failures: int, lockout: float, now: float | None = None):
        now = time.monotonic() if now is None else now
        with self._lock:
            failures = self._failures.setdefault(key, deque())
            while failures and failures[0] <= now - lockout:
                failures.popleft()
            failures.append(now)
            if len(failures) >= max_failures:
                self._locked_until[key] = now + lockout
                del self._failures[key]
            # Bound memory under a spray of random emails.
            if len(self._failures) > 10000:
                for k in [k for k, d in self._failures.items() if d[-1] <= now - lockout]:
                    del self._failures[k]

    def record_success(self, key: str):
        with self._lock:
            self._failures.pop(key, None)
            self._locked_until.pop(key, None)

    def reset(self):
        with self._lock:
            self._failures.clear()
            self._locked_until.clear()


limiter = SlidingWindowLimiter()
login_guard = LoginGuard()


def reset_rate_limits():
    """Forget every counter and lockout (tests call this in setUp)."""
    limiter.reset()
    login_guard.reset()


def check_rate(scope: str, limit: int, per: float, key: str | None = None):
    """Count one request against `scope` for `key` (default: client IP); raise RateLimited when over."""
    if not _enabled():
        return
    wait = limiter.hit(f"{scope}:{key if key is not None else client_ip()}", limit, per)
    if wait is not None:
        raise RateLimited(wait)


def rate_limit(scope: str, limit: int, per: float = 60, key=None):
    """
    Route decorator: at most `limit` requests per `per` seconds. Requests
    are counted per client IP, or per the value of `key()` when given
    (`user_key`, `user_ip_key`). Place it BELOW `require_roles` when the
    key needs the current user.
    """
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            check_rate(scope, limit, per, key() if key else None)
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def user_key() -> str:
    """Key for per-user limits (requires an authenticated request)."""
    from app.utils.auth import load_current_user
    return f"user:{load_current_user().id}"


def user_ip_key() -> str:
    """Per signed-in account AND client address: separate kiosks sharing one account each get their own budget."""
    from app.utils.auth import load_current_user
    return f"user:{load_current_user().id}@{client_ip()}"


# --- sign-in lockout -------------------------------------------------------

def check_login_lockout(email: str):
    if not _enabled():
        return
    wait = login_guard.retry_after(email.lower())
    if wait is not None:
        raise RateLimited(wait, "Too many failed sign-in attempts. Try again in {} minutes.".format(
            max(1, int(math.ceil(wait / 60)))))


def record_login_failure(email: str):
    if not _enabled():
        return
    cfg = current_app.config
    login_guard.record_failure(email.lower(), int(cfg.get("LOGIN_MAX_FAILURES", 5)),
                               60 * int(cfg.get("LOGIN_LOCKOUT_MINUTES", 15)))


def record_login_success(email: str):
    login_guard.record_success(email.lower())
