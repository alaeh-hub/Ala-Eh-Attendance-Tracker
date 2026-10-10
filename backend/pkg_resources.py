"""
Minimal shim for pkg_resources.resource_filename used by face_recognition_models.
Placed inside backend/ so it is importable when running the app from backend/run.py.
"""
import importlib
import importlib.resources
import os

def resource_filename(package, resource_name):
    try:
        resource = importlib.resources.files(package) / resource_name
        try:
            return str(resource)
        except Exception:
            pkg = importlib.import_module(package)
            base = os.path.dirname(getattr(pkg, '__file__', ''))
            return os.path.join(base, resource_name)
    except Exception:
        pkg = importlib.import_module(package)
        base = os.path.dirname(getattr(pkg, '__file__', ''))
        return os.path.join(base, resource_name)

__all__ = ['resource_filename']
