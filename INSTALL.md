# Installation Guide

Complete installation instructions for the Uncertainty Annotation Apparatus (UAA).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation Methods](#installation-methods)
  - [Quick Start (Recommended)](#quick-start-recommended)
  - [Manual Installation](#manual-installation)
- [Reviewer Deployment](#reviewer-deployment)
- [Service Configuration](#service-configuration)
- [Verification](#verification)
- [Updating](#updating)
- [Uninstallation](#uninstallation)

---

## Prerequisites

### Required Software

| Software | Version | Purpose | Download |
|----------|---------|---------|----------|
| Docker Desktop | 4.0+ | Container runtime | [docker.com](https://www.docker.com/products/docker-desktop) |
| Node.js | 22 LTS+ | OHIF development | [nodejs.org](https://nodejs.org/) |
| Python | 3.12+ | Analysis scripts | [python.org](https://python.org/) |
| Git | 2.30+ | Version control | [git-scm.com](https://git-scm.com/) |
| Yarn | 1.22+ | Package manager | `npm install -g yarn` |

### Windows-Specific Requirements

1. **WSL2 Backend** (recommended for Docker Desktop)
   ```powershell
   wsl --install
   wsl --set-default-version 2
   ```

2. **PowerShell Execution Policy** (for running scripts)
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```

3. **Enable required Windows features**
   ```powershell
   dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
   dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
   ```

## Installation Methods

### Quick Start (Recommended)

```bash
# 1. Clone the repository
git clone https://github.com/BSeeTech/uncertainty-annotation-apparatus.git
cd uncertainty-annotation-apparatus

# 2. Configure environment
cp .env.example .env
# EDIT .env: set POSTGRES_PASSWORD to a strong password

# 3. Provision the MONAI Label checkpoint (downloads the official spleen UNet)
python servers/monai-label/scripts/install_checkpoint.py

# 4. Start all core services
docker compose up -d

# 5. Start the OHIF viewer
cd ohif-viewer

# Configure the viewer (optional but recommended): the stock fallback already
# points at the local stack, but this makes it explicit.
cd platform/app && cp .env.example .env && cd ../..

yarn install
yarn dev

# 6. Open in browser
# http://localhost:3000
```

> **Note:** The pretrained checkpoint (`pretrained_segmentation.pt`) is downloaded
> by `install_checkpoint.py` and verified against a SHA-256 lock file. It is not
> bundled in the repository.

### Manual Installation

For development without Docker:

#### Database
```bash
# Install PostgreSQL 15+
# Create database and user
psql -U postgres -c "CREATE USER medical_imaging WITH PASSWORD 'your-password';"
psql -U postgres -c "CREATE DATABASE annotations OWNER medical_imaging;"
psql -U medical_imaging -d annotations -f scripts/init-db.sql
```

#### Uncertainty Service
```bash
cd servers/uncertainty-service
python -m venv venv
source venv/bin/activate  # On Windows: .\venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env  # Edit with your DB credentials
uvicorn app.main:app --reload --port 58050
```

#### MONAI Label (GPU recommended)
```bash
cd servers/monai-label
pip install -r requirements.txt
# Download the pretrained checkpoint
python scripts/install_checkpoint.py
monailabel start_server \
  --app . \
  --studies /path/to/your/studies \
  --host 0.0.0.0 \
  --port 8000 \
  --conf models segmentation,mcdropout_seg
```

#### Collaboration Server
```bash
cd servers/collaboration
npm install
cp .env.example .env
node server.js
```

#### OHIF Viewer
```bash
cd ohif-viewer
yarn install
yarn dev
```

## Reviewer Deployment

For distributed multi-site review workflows where reviewers do not have GPU access:

### 1. Generate the inference artifacts (on the GPU-equipped host)

Run the administrative precompute inside the uncertainty-service container. It
runs MONAI Label inference for every configured case × C1/C2 condition and
publishes validated artifacts (segmentation, uncertainty, foreground probability):

```bash
# Ensure cases are registered first (see the replication sequence in
# evaluation/ct-spleen/README.md) — generation validates each series in Orthanc.
docker exec medical-uncertainty python /app/scripts/precompute_cases.py \
  --cases /evaluation/cases.json \
  --condition C2 \
  --report /tmp/precompute.json
```

Then copy the artifacts out of the container for distribution:

```bash
# The outputs live in the uncertainty-service volume. With the main stack
# running, they are already on the host volume; locate it via:
docker volume inspect medical-uncertainty-artifacts --format '{{.Mountpoint}}'
```

(For the older `scripts/precompute-all.sh`: it does **not** generate — it only
verifies that cached results exist for the reviewer profile and returns HTTP 409
when a generation is missing. Use `precompute_cases.py` to generate.)

### 2. Copy artifacts to the reviewer machine

Copy the entire `reviewer-artifacts/` directory to the target machine.

### 3. Start the reviewer stack (no GPU needed)

```bash
# Set the allocation
export REVIEWER_ID=R01
export CONDITION=C2

# Start lightweight stack
docker compose --profile reviewer up -d

# Open in browser
# http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2
```

The reviewer profile starts:
- A local PostgreSQL (host port 5433)
- The uncertainty service in pre-computed mode (no MONAI Label connection, host port 58051)
- An OHIF viewer configured for the reviewer

### 4. Collect results

After each reviewer completes their sessions, submit events are already stored in the reviewer PostgreSQL. Export the database:

```bash
pg_dump -h localhost -p 5433 -U medical_imaging annotations > reviewer-R01-results.sql
```

## Service Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_PASSWORD` | *(required)* | Database password |
| `POSTGRES_USER` | `medical_imaging` | Database user |
| `POSTGRES_DB` | `annotations` | Database name |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | CORS origins |
| `MONAI_LABEL_URL` | `http://monai-label:8000` | MONAI Label address |
| `ORTHANC_DICOMWEB_URL` | `http://orthanc:8042/dicom-web` | Orthanc DICOMweb |
| `DEFAULT_CASE_CONDITION` | `C2` | Default workflow condition |
| `UNCERTAINTY_OUTPUT_DIR` | `/var/lib/uncertainty-service/outputs` | NIfTI output path |
| `MC_DROPOUT_SAMPLES` | `16` | Stochastic forward passes for MC Dropout |

### Port Reference

| Port | Service |
|------|---------|
| 3000 | OHIF Viewer |
| 3001 | Collaboration Server |
| 5432 | PostgreSQL (main stack) |
| 5433 | PostgreSQL (reviewer profile) |
| 58050 | Uncertainty Service |
| 58051 | Uncertainty Service (reviewer profile) |
| 8000 | MONAI Label |
| 8042 | Orthanc (DICOMweb) |
| 8043 | Nginx (public proxy) |
| 8044 | MONAI Label (via proxy) |

## Verification

```powershell
# Check all containers are running
docker ps

# Verify core services
curl http://localhost:3001/health
curl http://localhost:8042/system
curl http://localhost:58050/health

# Run test suite
cd servers/uncertainty-service
python -m pytest -v
```

## Updating

```bash
# Pull latest code
git pull

# Rebuild containers
docker compose build --no-cache uncertainty-service monai-label

# Restart
docker compose up -d
```

## Uninstallation

```bash
# Stop and remove containers
docker compose down -v

# Remove volumes (WARNING: deletes all data)
docker volume rm medical-postgres-data medical-orthanc-data
```
