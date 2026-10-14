# face_recognition_models needs pkg_resources.resource_filename, which newer
# setuptools no longer provides. Install a narrow fallback before any vision
# module imports face_recognition (see _pkg_resources_compat).
from app.vision._pkg_resources_compat import install as _install_pkg_resources_compat

_install_pkg_resources_compat()
