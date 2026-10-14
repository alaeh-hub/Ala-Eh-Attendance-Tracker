from flask import Flask, jsonify
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from config import CONFIG
from app import config_check
from app.extensions import db, migrate, jwt, cors, socketio
from app.logging_config import configure_logging, register_request_logging
from app.middleware.error_handler import register_error_handlers


def create_app(config_object=CONFIG):
    app = Flask(__name__)
    app.config.from_object(config_object)

    configure_logging(app)
    config_check.enforce(app)
    if app.config.get("TRUST_PROXY_HOPS"):
        from werkzeug.middleware.proxy_fix import ProxyFix
        hops = app.config["TRUST_PROXY_HOPS"]
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=hops, x_proto=hops, x_host=hops)
    register_request_logging(app)

    db.init_app(app)
    migrate.init_app(app, db)
    jwt.init_app(app)
    cors.init_app(app, resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}},
                  expose_headers=["Content-Disposition", "X-Total-Count", "Retry-After"],
                  supports_credentials=True)
    socketio.init_app(app, cors_allowed_origins=_socket_origin_check(app))

    register_error_handlers(app)
    _register_jwt_errors()
    _register_security_headers(app)

    from app.api.auth_routes import auth_bp
    from app.api.user_routes import user_bp
    from app.api.department_routes import department_bp
    from app.api.enrollment_routes import enrollment_bp
    from app.api.recognition_routes import recognition_bp
    from app.api.attendance_routes import attendance_bp
    from app.api.report_routes import report_bp
    from app.api.review_routes import review_bp
    from app.api.admin_routes import admin_bp
    from app.api.meta_routes import meta_bp
    from app import sockets  # noqa: F401  (registers Socket.IO handlers)

    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(user_bp, url_prefix="/api/users")
    app.register_blueprint(department_bp, url_prefix="/api/departments")
    app.register_blueprint(enrollment_bp, url_prefix="/api/enrollment")
    app.register_blueprint(recognition_bp, url_prefix="/api/recognition")
    app.register_blueprint(attendance_bp, url_prefix="/api/attendance")
    app.register_blueprint(report_bp, url_prefix="/api/reports")
    app.register_blueprint(review_bp, url_prefix="/api/review")
    app.register_blueprint(admin_bp, url_prefix="/api/admin")
    app.register_blueprint(meta_bp, url_prefix="/api/meta")

    @app.get("/api/health")
    def health():
        try:
            db.session.execute(text("SELECT 1"))
        except SQLAlchemyError:
            db.session.rollback()
            app.logger.exception("health check database probe failed")
            return jsonify({"ok": False, "error": "Database unavailable"}), 503
        return jsonify({"ok": True, "database": "ok"})

    with app.app_context():
        from app import models  # noqa: F401  (ensure every table is registered)
        from app.schema_upgrade import upgrade_schema
        from app.services.embedding_index import embedding_index

        if app.config.get("AUTO_CREATE_SCHEMA", True) or app.testing:
            # Development/tests only. Production applies Alembic migrations
            # with `python manage_db.py upgrade` before the server starts.
            db.create_all()
            upgrade_schema()
        embedding_index.invalidate()

    return app


def _socket_origin_check(app):
    """
    Socket.IO origin policy: the configured CORS_ORIGINS plus the site's own
    origin. engine.io only accepts what is listed, so a same-origin deploy
    behind Caddy would otherwise refuse the dashboard's live feed whenever
    CORS_ORIGINS missed the public https:// address. The Socket.IO layer sits
    outside ProxyFix, so the forwarded scheme/host are read here directly,
    and only when a proxy is trusted.
    """
    configured = set(app.config["CORS_ORIGINS"])
    if "*" in configured:
        return "*"
    trust_proxy = bool(app.config.get("TRUST_PROXY_HOPS"))

    def _first(value):
        return value.split(",")[0].strip()

    def allowed(origin, environ=None):
        if not origin:
            return True  # non-browser client; the JWT check still applies
        if origin in configured:
            return True
        if environ is None:
            return False
        own = set()
        host = environ.get("HTTP_HOST")
        if host:
            own.add(f"{environ.get('wsgi.url_scheme', 'http')}://{host}")
        if trust_proxy:
            scheme = _first(environ.get("HTTP_X_FORWARDED_PROTO", "")) or environ.get("wsgi.url_scheme", "http")
            fwd_host = _first(environ.get("HTTP_X_FORWARDED_HOST", "")) or host
            if fwd_host:
                own.add(f"{scheme}://{fwd_host}")
        return origin in own

    return allowed


def _register_jwt_errors():
    """Return JSON 401s (not 422s) for bad/expired tokens so the frontend can refresh or log out."""
    @jwt.expired_token_loader
    def expired(_header, _payload):
        return jsonify({"error": "Session expired.", "code": "TOKEN_EXPIRED"}), 401

    @jwt.invalid_token_loader
    def invalid(reason):
        return jsonify({"error": "Invalid session.", "code": "TOKEN_INVALID"}), 401

    @jwt.unauthorized_loader
    def missing(reason):
        # Also reached for a refresh cookie sent without (or with a wrong) X-CSRF-TOKEN header.
        if "CSRF" in str(reason):
            return jsonify({"error": "Missing or invalid CSRF token.", "code": "CSRF_FAILED"}), 401
        return jsonify({"error": "Sign in required.", "code": "TOKEN_MISSING"}), 401

    # Logout / kiosk lock blocklist + per-user token_version (see app/utils/auth.py).
    @jwt.token_in_blocklist_loader
    def blocklisted(_header, payload):
        from app.utils.auth import token_revoked
        return token_revoked(payload)

    @jwt.revoked_token_loader
    def revoked(_header, _payload):
        return jsonify({"error": "Session revoked. Please sign in again.", "code": "TOKEN_REVOKED"}), 401


def _register_security_headers(app):
    """Conservative headers for every API response (JSON and images only,
    so a strict CSP costs nothing). The web UI's own headers are set by the
    static file server in front of it."""
    @app.after_request
    def headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        response.headers.setdefault("Cross-Origin-Resource-Policy", "same-site")
        if response.mimetype == "application/json":
            response.headers.setdefault("Cache-Control", "no-store")
        return response
