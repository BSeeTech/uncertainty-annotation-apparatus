# MONAI Label app for the Medical Imaging Platform.
#
# CPU-only image by default (smoke-testable on a laptop without GPU).
# For GPU acceleration, swap the base image for nvcr.io/nvidia/pytorch:24.03-py3
# in a docker-compose.gpu.yml override and add `--gpus all` at runtime.

FROM python:3.10-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System libs needed by ITK / OpenSlide / DICOM tooling.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
        libxrender1 \
        ca-certificates \
        libcurl4 \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/app

# Install Python deps first so changes to app code don't bust the layer cache.
COPY requirements.txt /tmp/requirements.txt
RUN pip install --upgrade pip && \
    pip install --extra-index-url https://download.pytorch.org/whl/cpu \
        -r /tmp/requirements.txt

# Application code.
COPY main.py ./
COPY lib/ ./lib/
COPY scripts/ ./scripts/

# Data and model directories live on volumes mounted at runtime.
RUN mkdir -p /workspace/data /workspace/app/model

EXPOSE 8000

# Default command: start the MONAI Label server with both inference tasks
# enabled.  Override `--studies` and `--conf` via docker-compose.
ENTRYPOINT ["monailabel"]
CMD ["start_server", \
     "--app", "/workspace/app", \
     "--studies", "/workspace/data/dicom", \
     "--conf", "models", "segmentation,mcdropout_seg", \
     "--host", "0.0.0.0", \
     "--port", "8000"]
