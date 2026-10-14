"""
Locks for the vision models.

Production runs under ``gunicorn -k eventlet``, which monkey-patches
``threading`` so ``threading.Lock()`` becomes a *green* lock. Recognition,
however, runs in native OS threads (``eventlet.tpool``, see
app/utils/blocking.py), and green locks do not work across OS threads: a
contended acquire parks on that thread's own hub and is never woken by a
release from another thread. The model locks guard pure C++ calls that never
yield, so a real OS lock is both correct and safe for greenlets.
"""
import sys
import threading


def native_lock():
    """An OS-level lock even when eventlet has patched `threading`."""
    eventlet = sys.modules.get("eventlet")
    if eventlet is not None:
        try:
            from eventlet import patcher

            if patcher.is_monkey_patched("thread"):
                return patcher.original("_thread").allocate_lock()
        except Exception:  # noqa: BLE001 - fall back to the stdlib lock
            pass
    return threading.Lock()
