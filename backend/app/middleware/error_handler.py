import logging

from flask import jsonify, request
from werkzeug.exceptions import HTTPException

logger = logging.getLogger("app.errors")


class AppError(Exception):
    """Base class for application-level errors with an HTTP status code."""
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


def register_error_handlers(app):
    @app.errorhandler(AppError)
    def handle_app_error(err):
        # A route may have loaded or modified ORM objects before rejecting a
        # request. Clear that transaction so the pooled session is safe for
        # the next request.
        from app.extensions import db
        db.session.rollback()
        # 4xx here is routine (validation, auth, business rules) — log at
        # debug so it doesn't drown real problems, but keep it discoverable.
        logger.debug("AppError %s %s -> %s: %s", request.method, request.path, err.status_code, err.message)
        response = {"error": err.message, **err.payload}
        return jsonify(response), err.status_code

    @app.errorhandler(HTTPException)
    def handle_http_error(err):
        from app.extensions import db
        db.session.rollback()
        logger.debug("HTTPException %s %s -> %s: %s", request.method, request.path, err.code, err.description)
        return jsonify({"error": err.description}), err.code

    @app.errorhandler(Exception)
    def handle_unexpected_error(err):
        from app.extensions import db
        db.session.rollback()
        app.logger.exception("Unhandled exception")
        return jsonify({"error": "Internal server error"}), 500
