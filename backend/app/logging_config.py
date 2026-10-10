"""
Central logging setup. Replaces Flask's bare default (console-only,
werkzeug access lines, no request correlation) with:

  - a console handler (human-readable, for `flask run` / docker logs), and
  - a rotating file handler under LOG_DIR (default backend/logs/app.log),
    so history survives container/process restarts and isn't lost the
    moment the console scrollback fills up.

Every request gets a short correlation id (`g.request_id`) stamped into
every log line via a logging.Filter, so the request_logger's one-line
summary and any route-level `current_app.logger.info(...)` calls for that
same request can be grepped together.

Route code should log the FACE MATCH SCORE and other decision numbers
explicitly (see recognition_routes.py / face_service.py) — the request
summary line alone only has status/timing, not *why* a scan was accepted
or rejected.
"""
import logging
import os
import time
import uuid
from logging.handlers import RotatingFileHandler

from flask import g, request

LOG_FORMAT = "%(asctime)s %(levelname)-8s [%(request_id)s] %(name)s: %(message)s"
DEFAULT_LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "logs")


class _RequestIdFilter(logging.Filter):
    """Injects the current request's short id (or "-" outside a request) into every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            # getattr(g, ...) (not g.request_id) because g raises
            # AttributeError, not just outside any context — before_request
            # also hasn't run yet for code invoked directly (tests, CLI
            # scripts, scheduled jobs running "with app.app_context()").
            record.request_id = getattr(g, "request_id", "-")
        except RuntimeError:  # outside an application context entirely
            record.request_id = "-"
        return True


def configure_logging(app) -> None:
    log_dir = app.config.get("LOG_DIR", DEFAULT_LOG_DIR)
    os.makedirs(log_dir, exist_ok=True)
    level_name = app.config.get("LOG_LEVEL", "INFO")
    level = getattr(logging, str(level_name).upper(), logging.INFO)

    formatter = logging.Formatter(LOG_FORMAT)
    request_id_filter = _RequestIdFilter()

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    console_handler.addFilter(request_id_filter)

    file_handler = RotatingFileHandler(
        os.path.join(log_dir, "app.log"), maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    file_handler.addFilter(request_id_filter)

    root = logging.getLogger()
    root.setLevel(level)
    # Flask's app.logger propagates to root; avoid duplicate handlers on
    # the reloader's second import or on repeated create_app() calls (tests).
    # Closing matters when the app factory is called repeatedly (for example
    # by tests): clearing alone leaves the old rotating file handles open.
    for handler in root.handlers[:]:
        root.removeHandler(handler)
        handler.close()
    root.addHandler(console_handler)
    root.addHandler(file_handler)

    # werkzeug's own access log (GET /api/... 200 -) goes through the same
    # handlers instead of printing unformatted lines straight to stderr.
    logging.getLogger("werkzeug").setLevel(level)

    app.logger.setLevel(level)
    app.logger.info("Logging configured: level=%s dir=%s", level_name, log_dir)


def register_request_logging(app) -> None:
    """One summary line per request: method, path, status, duration, caller — cheap and always on."""

    @app.before_request
    def _start_timer():
        g.request_id = uuid.uuid4().hex[:8]
        g.request_started = time.perf_counter()

    @app.after_request
    def _log_request(response):
        # The idle kiosk polls this about once a second all night; only failures are worth a line.
        if request.path.endswith("/recognition/presence") and response.status_code < 400:
            return response
        started = getattr(g, "request_started", None)
        duration_ms = round((time.perf_counter() - started) * 1000, 1) if started else None
        # Never log request bodies: enrollment/check-in payloads carry face
        # images, and auth payloads carry passwords.
        app.logger.info(
            "%s %s -> %s (%sms) ip=%s",
            request.method,
            request.full_path if request.query_string else request.path,
            response.status_code,
            duration_ms,
            request.headers.get("X-Forwarded-For", request.remote_addr),
        )
        return response
