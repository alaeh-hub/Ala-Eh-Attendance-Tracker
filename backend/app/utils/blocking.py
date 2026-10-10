import logging

from flask import current_app

from app.extensions import socketio

logger = logging.getLogger("app.blocking")


def run_blocking(fn, *args, **kwargs):
    """
    Run CPU-bound work (face detection/embedding) without freezing the
    server. Under eventlet a long call blocks every greenlet — Socket.IO
    pings, other kiosks, the dashboard — so it is pushed to a native
    thread via eventlet.tpool. Elsewhere it simply runs inline.
    """
    app = current_app._get_current_object()
    if app.testing or not app.config.get("OFFLOAD_RECOGNITION", True) or socketio.async_mode != "eventlet":
        return fn(*args, **kwargs)

    def job():
        with app.app_context():
            return fn(*args, **kwargs)

    from eventlet import tpool
    return tpool.execute(job)
