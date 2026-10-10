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
    register_request_logging(app)

    db.init_app(app)
    migrate.init_app(app, db)
    jwt.init_app(app)
    cors.init_app(app, resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}},
                  expose_headers=["Content-Disposition"])
    socketio.init_app(app, cors_allowed_origins=app.config["CORS_ORIGINS"])

    register_error_handlers(app)
    _register_jwt_errors()

    from app.api.auth_routes import auth_bp
    from app.api.user_routes import user_bp
    from app.api.department_routes import department_bp
    from app.api.enrollment_routes import enrollment_bp
    from app.api.recognition_routes import recognition_bp
    from app.api.attendance_routes import attendance_bp
    from app.api.report_routes import report_bp
    from app.api.review_routes import review_bp
    from app.api.admin_routes import admin_bp
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

        db.create_all()  # For dev convenience. Use Flask-Migrate in production.
        upgrade_schema()
        embedding_index.invalidate()

    return app


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
        return jsonify({"error": "Sign in required.", "code": "TOKEN_MISSING"}), 401
