# syntax=docker/dockerfile:1
#
# Production image for the Flask/Socket.IO backend.
#   builder: compiles dlib (and any other sdists) into wheels
#   runtime: slim Python with only the shared libraries those wheels need,
#            running as an unprivileged user
ARG PYTHON_IMAGE=python:3.11.13-slim-bookworm

# ---------------------------------------------------------------- builder
FROM ${PYTHON_IMAGE} AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake libopenblas-dev liblapack-dev \
    && rm -rf /var/lib/apt/lists/*

# dlib compiles C++; limit parallelism so the build doesn't OOM Docker Desktop's VM.
ENV CMAKE_BUILD_PARALLEL_LEVEL=1 MAKEFLAGS=-j1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1

WORKDIR /build
COPY requirements.txt .
RUN pip wheel --wheel-dir /wheels -r requirements.txt

# ---------------------------------------------------------------- runtime
FROM ${PYTHON_IMAGE} AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    APP_ENV=production \
    LOG_DIR=/app/logs

# Runtime shared libraries for dlib (BLAS/LAPACK) and OpenCV.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libopenblas0 liblapack3 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app
COPY requirements.txt .
RUN --mount=type=bind,from=builder,source=/wheels,target=/wheels \
    pip install --no-index --find-links=/wheels -r requirements.txt \
    # fail the build now (not at 3am) if a native library is missing
    # (face_recognition_models is only located, not imported: it needs
    # pkg_resources, which the app shims at runtime - app/vision/_pkg_resources_compat.py)
    && python -c "import importlib.util, dlib, cv2, numpy, psycopg2, eventlet; assert importlib.util.find_spec('face_recognition_models'); print('native libs ok')"

# Application code stays root-owned (read-only for the app user); only the
# log directory is writable.
COPY . .
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/logs \
    && chown app:app /app/logs

USER app
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5000/api/health', timeout=4).status == 200 else 1)"]

ENTRYPOINT ["docker-entrypoint.sh"]
# Exactly one eventlet worker: Socket.IO sessions, rate limits, the liveness
# pool and the embedding index all live in this process's memory.
CMD ["gunicorn", "-k", "eventlet", "-w", "1", "--bind", "0.0.0.0:5000", \
     "--timeout", "120", "--graceful-timeout", "30", \
     "--access-logfile", "-", "--error-logfile", "-", "run:app"]
