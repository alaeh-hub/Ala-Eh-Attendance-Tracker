"""Pay the one-off start-up costs before the first request arrives.

The face engine loads its ONNX models lazily, which takes a couple of seconds the first time anything
asks for it (even the dashboard's headcount does). The server runs a single eventlet worker, so while
that load runs every other request waits too: the first page after a restart took ~2.5 s, for every
request in flight. Doing it here moves that cost into start-up, where the health check is still
waiting anyway.

Failure is logged, never raised: the lazy path still works exactly as before.
"""
import logging
import time

logger = logging.getLogger("app.warmup")


def warm_up(app) -> None:
    if not app.config.get("WARM_UP", True):
        return
    started = time.perf_counter()
    try:
        with app.app_context():
            from app.extensions import db
            from app.services.embedding_index import active_engine, embedding_index
            from sqlalchemy import text

            engine = active_engine()           # loads detector + recogniser models
            db.session.execute(text("SELECT 1"))  # opens the first pooled connection
            embedding_index.size               # builds the in-memory matrix of enrolled faces
            db.session.remove()
        logger.info("warm-up done: engine=%s in %d ms", engine.name, (time.perf_counter() - started) * 1000)
    except Exception:  # noqa: BLE001 - warm-up is an optimisation, not a requirement
        logger.exception("warm-up failed; models will load on first use instead")
