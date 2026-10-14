"""
Fallback for the one `pkg_resources` function face_recognition_models needs.

face_recognition_models (a dependency of face_recognition) does
``from pkg_resources import resource_filename`` to find its bundled .dat
models. setuptools >= 81 no longer ships ``pkg_resources``, so on a fresh
environment that import fails and the dlib engine / blink liveness cannot load.

This used to be solved with a top-level ``backend/pkg_resources.py``, which
shadowed setuptools' real module for the whole process whenever the app ran from
backend/. Instead, :func:`install` registers this minimal module under
``sys.modules['pkg_resources']`` ONLY when the real one cannot be imported. It
is called from ``app/vision/__init__.py`` so it always runs before any module
that imports face_recognition.
"""
from __future__ import annotations

import importlib
import importlib.util
import logging
import os
import sys
import types

logger = logging.getLogger("app.vision")

COMPAT_MARKER = "__face_attendance_pkg_resources_compat__"


def resource_filename(package_or_requirement, resource_name: str) -> str:
    """Filesystem path of `resource_name` inside an installed (non-zipped) package."""
    package = getattr(package_or_requirement, "__name__", package_or_requirement)
    spec = importlib.util.find_spec(package)
    if spec is not None and spec.submodule_search_locations:
        base = list(spec.submodule_search_locations)[0]
    elif spec is not None and spec.origin:
        base = os.path.dirname(spec.origin)
    else:
        module = importlib.import_module(package)
        base = os.path.dirname(getattr(module, "__file__", "") or "")
    return os.path.join(base, *resource_name.split("/"))


def _build_module() -> types.ModuleType:
    module = types.ModuleType("pkg_resources", "Minimal pkg_resources compatibility shim (resource_filename only).")
    module.resource_filename = resource_filename
    module.__all__ = ["resource_filename"]
    setattr(module, COMPAT_MARKER, True)
    return module


def install() -> bool:
    """Register the shim if `import pkg_resources` fails. Returns True when installed."""
    try:
        import pkg_resources  # noqa: F401  - the real one (setuptools < 81) wins
        return False
    except ImportError:
        pass
    sys.modules["pkg_resources"] = _build_module()
    logger.debug("pkg_resources unavailable; installed resource_filename compatibility shim")
    return True
