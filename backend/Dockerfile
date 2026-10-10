FROM python:3.11-slim

# dlib/opencv build deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake libopenblas-dev liblapack-dev \
    libsm6 libxext6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# dlib compiles C++; limit parallelism so the build doesn't OOM Docker Desktop's VM
ENV CMAKE_BUILD_PARALLEL_LEVEL=1 MAKEFLAGS=-j1
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000
CMD ["gunicorn", "-k", "eventlet", "-w", "1", "-b", "0.0.0.0:5000", "run:app"]
