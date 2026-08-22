# Uncertainty Annotation Apparatus (UAA)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)
[![OHIF](https://img.shields.io/badge/OHIF-v3-green.svg)](https://ohif.org/)
[![MONAI Label](https://img.shields.io/badge/MONAI%20Label-Integrated-orange.svg)](https://monai.io/)
[![Python 3.12+](https://img.shields.io/badge/Python-3.12+-blue.svg)](https://python.org)
[![Node 22+](https://img.shields.io/badge/Node-22+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)](https://typescriptlang.org)

A web-based, collaborative medical imaging annotation platform featuring **real-time collaboration**, **AI-assisted segmentation with uncertainty estimation**, and **high-performance DICOM viewing**.

The platform bridges the gap between basic desktop viewers and expensive enterprise PACS systems, targeting:

- **Small Research Units** — Affordable collaborative annotation tools
- **Medical Labs** — AI-integrated segmentation workflows with uncertainty estimation
- **Educational Institutions** — Real-time teaching and learning environments

---

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🖼️ **DICOM Viewing** | High-performance 2D, 3D, and MPR viewing using OHIF v3 + Cornerstone3D |
| 🤝 **Real-time Collaboration** | 1-to-1 session-based collaboration with synchronized viewports and annotations |
| 🤖 **AI Segmentation** | MONAI Label integration with MC Dropout uncertainty estimation (T=16) |
| 🔬 **Uncertainty Visualisation** | Per-voxel predictive entropy heatmap overlay with opacity controls |
| 📋 **Prioritised Worklists** | Case-level uncertainty scoring (mean foreground entropy, band classification) |
| 📊 **Event Logging** | Buffered event stream via `sendBeacon` for per-condition time/action analysis |
| 🔄 **Condition System** | URL-driven workflow switching (`?reviewer=R01&condition=C2`) — C0–C2 implemented and verified, C3–C5 gated scaffolding |
| 🧪 **Placebo Control** | `saliency_placebo` inference task (Sobel edge-magnitude) built and registered, but not yet wired into a runnable session |
| 📦 **Distributed Reviewer Deployment** | Standalone Docker Compose profile for multi-site review workflows |
| 💾 **Annotation Persistence** | PostgreSQL-backed storage for annotations, segmentations, and event traces |

## 🏗️ Architecture

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                         OHIF Viewer (Port 3000)                               │
│  ┌──────────────────┐  ┌─────────────────────┐  ┌────────────────────────┐   │
│  │  Collaboration   │  │ Uncertainty Extension│  │   Cornerstone3D        │   │
│  │  Extension       │  │  ┌─────────────────┐ │  │   Extension             │   │
│  │                  │  │  │ UncertaintySvc  │ │  │                        │   │
│  │                  │  │  │ HeatmapRenderer │ │  │                        │   │
│  │                  │  │  │ EventLogger     │ │  │                        │   │
│  │                  │  │  │ SnapshotService │ │  │                        │   │
│  │                  │  │  │ WorklistApi     │ │  │                        │   │
│  │                  │  │  └─────────────────┘ │  │                        │   │
│  └────────┬─────────┘  └──────────┬──────────┘  └────────────────────────┘   │
└───────────┼───────────────────────┼──────────────────────────────────────────┘
            │                       │
            ▼                       ▼
┌───────────────────┐  ┌───────────────────────┐  ┌───────────────────────────┐
│  Collaboration    │  │   Uncertainty Service  │  │     Orthanc PACS          │
│  Server           │  │   (Port 58050)         │  │    (DICOM Storage)        │
│  (Port 3001)      │  │                        │  │     (Port 8042)           │
│                   │  │  /infer — condition    │  │                           │
│  Socket.IO        │  │  /worklist — scoring   │  │  DICOMweb API             │
│  REST API         │  │  /events — logging     │  │  WADO-RS/STOW-RS          │
│                   │  │  /analysis — calibration│ │                           │
└────────┬──────────┘  └───────────┬───────────┘  └───────────────────────────┘
         │                        │
         ▼                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           PostgreSQL (Port 5432)                              │
│  cases | uncertainty_scores | annotation_status | events | sessions          │
└──────────────────────────────────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
┌───────────────────┐  ┌───────────────────────┐
│  MONAI Label      │  │   Nginx Proxy         │
│  (Port 8000)      │  │   (CORS/Route)        │
│                   │  │   (8043/8044)          │
│  segmentation     │  │                        │
│  mcdropout_seg    │  │  Proxies:              │
│  saliency_placebo │  │  Orthanc → 8042        │
│  (C3 control)     │  │  MONAI → 8000          │
└───────────────────┘  └───────────────────────┘
```

See [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for a deeper walkthrough of each service, data flow, and the condition-routing design.

## 🚀 Quick Start

### Prerequisites

- **Docker Desktop** 4.0+ with Docker Compose v2
- **Node.js** 22+ (for OHIF development)
- **Python** 3.12+ (for analysis scripts)
- **Git**
- **8GB+ RAM** recommended (MONAI Label is memory-intensive)

### One-Command Setup

```bash
# Clone the repository
git clone https://github.com/BSeeTech/uncertainty-annotation-apparatus.git
cd uncertainty-annotation-apparatus

# Copy environment configuration
cp .env.example .env
# Edit .env to set POSTGRES_PASSWORD

# Provision the MONAI Label checkpoint (downloads the official spleen UNet)
python servers/monai-label/scripts/install_checkpoint.py

# Start all services
docker compose up -d

# Start OHIF Viewer (in a separate terminal)
cd ohif-viewer

# Configure the viewer (optional but recommended): the stock fallback already
# points at the local stack, but this makes it explicit.
cd platform/app && cp .env.example .env && cd ../..

yarn install
yarn dev
```

### Access Points

| Service | URL | Description |
|---------|-----|-------------|
| OHIF Viewer | http://localhost:3000 | Main application interface |
| Orthanc | http://localhost:8042 | PACS administration |
| MONAI Label | http://localhost:8044 | AI segmentation (via proxy) |
| Uncertainty Service | http://localhost:58050/docs | Worklist, inference orchestration, events |
| Collaboration API | http://localhost:3001 | REST API & WebSocket |

### Loading example data (for testers, including non-technical ones)

Once the stack is up, load the five example spleen cases with **one command**
(downloads ~1.5 GB on first run, resumable, prints plain-language progress):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-demo-data.ps1
```

When it finishes with a green "Demo data is ready!", open
`http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2`.
Radiologists and other non-technical testers only need this step plus the
browser — see [GETTING-STARTED.md](GETTING-STARTED.md) for a jargon-free walkthrough.

### Entering a Review Session

```
http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2
```

The `condition` parameter switches between workflow conditions without code changes. See [the API documentation](API.md) for details.

## 📁 Project Structure

```
uncertainty-annotation-apparatus/
├── docker-compose.yml              # Container orchestration (incl. reviewer profile)
├── .env                            # Environment configuration
├── servers/
│   ├── collaboration/              # Real-time collaboration server
│   │   └── server.js               # Express + Socket.IO server
│   ├── uncertainty-service/        # FastAPI uncertainty workflow API
│   │   ├── app/main.py             # Orchestration (17 routes, condition routing)
│   │   ├── app/analysis/           # Calibration metrics, temp scaling, reliability
│   │   └── tests/                  # Test suite
│   ├── monai-label/                # Custom MONAI Label app with MC Dropout
│   │   ├── lib/infers/             # mcdropout_seg.py, saliency_placebo.py (C3)
│   │   └── lib/configs/            # segmentation.py, mcdropout_seg.py
│   ├── orthanc/                    # PACS configuration
│   └── nginx/                      # Reverse proxy configuration
├── scripts/
│   ├── precompute-all.sh           # Verify cached reviewer artifacts (does not generate)
│   ├── analyze_reversions.py       # Edit reversion & trust-trajectory analysis
│   ├── analyze_interrater.py       # Pairwise inter-rater agreement analysis
│   ├── init-db.sql                 # Database initialization
│   └── *.ps1                       # PowerShell utilities
├── ohif-viewer/
│   ├── extensions/
│   │   ├── extension-uncertainty/  # Uncertainty heatmap, worklist, event logger
│   │   ├── collaboration/          # Real-time collaboration extension
│   │   └── monai-label/            # AI segmentation extension
│   ├── modes/
│   │   ├── uncertainty-review/     # Condition-gated review mode
│   │   └── collaboration/          # Collaboration viewing mode
│   └── platform/                   # OHIF core platform
├── evaluation/ct-spleen/           # CT spleen evaluation pipeline
└── scripts/                        # Ops and analysis scripts (PowerShell, bash)
```

> **⚠️ Warning — test data is a large download, not bundled.**
> The MSD Task09 Spleen volumes (~1.5 GB) are **not in this repository** and are
> **not required to start or use the platform**. They are only needed if you want
> to **replicate the evaluation results**.
>
> - Run `python evaluation/ct-spleen/install_dataset.py` from the repo root to
>   download and verify them (live progress, automatic resume on interruption).
> - On a slow connection this can take **30+ minutes** — the installer is working
>   even when the terminal looks idle; watch the progress line.
> - The data is **NIfTI (.nii.gz)**, not DICOM: it feeds MONAI Label's filesystem
>   datastore and the evaluation pipeline. It is **not** directly viewable in the
>   OHIF viewer at `localhost:3000` unless you first convert NIfTI → DICOM.
> - See [evaluation/ct-spleen/README.md](evaluation/ct-spleen/README.md) for the
>   full replication sequence.

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [Installation Guide](INSTALL.md) | Detailed setup instructions |
| [User Guide](USER_GUIDE.md) | End-user documentation |
| [Developer Guide](DEVELOPER_GUIDE.md) | Technical documentation — extensions, conditions, adapters |
| [API Reference](API.md) | REST & WebSocket API docs (including uncertainty service) |
| [Getting Started](GETTING-STARTED.md) | Quickstart after installation |
| [Troubleshooting](TROUBLESHOOTING.md) | Common issues & solutions |
| [Contributing](CONTRIBUTING.md) | How to contribute |

## 🔬 Condition System

The platform supports a **condition-routed review workflow**, switchable via URL parameter
(`?reviewer=R01&condition=C2`). **C0–C2 are implemented and verified**; C3–C5 are gated
scaffolding toward a factorial extension and **cannot currently run a session** (see below).

| Param | Behaviour | `attachHeatmap` | `importAiMask` | Worklist Policy |
|-------|-----------|:---:|:---:|:---:|
| `C0` | Manual annotation from scratch | ❌ | ❌ | default (high-uncertainty first) |
| `C1` | AI pre-annotation, no heatmap | ❌ | ✅ | default (high-uncertainty first) |
| `C2` | AI + entropy heatmap + prioritised | ✅ | ✅ | default (high-uncertainty first) |
| `C3` | AI + edge-placebo overlay + prioritised | ✅ (Sobel) | ✅ | — not wired |
| `C4` | AI + prioritised worklist, no heatmap | ❌ | ✅ | — not wired |
| `C5` | AI + entropy heatmap, random order | ✅ | ✅ | — not wired |

**Implemented and verified: C0, C1, C2.** These three conditions isolate manual
annotation, AI pre-annotation, and the bundled uncertainty-guidance package (heatmap +
prioritised worklist). They are enforced at the service layer, not the panel layer, and are
covered by functional tests (condition gating and reviewer-intent timing).

**C3–C5 are scaffolding, not usable conditions.** The six-arm `Condition` type, the
client plan computation, and the MONAI Label `saliency_placebo` inference task exist
(`servers/monai-label/lib/infers/saliency_placebo.py`), but every execution path is fenced
to C0–C2: the server's `POST /infer/{case_id}` rejects any condition other than C1/C2
with HTTP 400 ("C3/C4/C5 are not yet connected to this endpoint"), the client
recomputes condition checks internally rather than consuming the plan output, and no
test exercises C3–C5. They are the documented head start on a six-arm factorial extension
of the C0–C2 design, not a usable capability.

**Worklist policy.** The client requests the server's default policy (`high_first`) in every
condition; the FIFO and randomised orderings exist server-side but are not selectable by
condition.

## 🧪 Distributed Reviewer Deployment

For multi-site review workflows:

```bash
# 1. Generate all inference artifacts (GPU recommended — MC Dropout T=16)
#    Cases must be registered first (see evaluation/ct-spleen/README.md).
docker exec medical-uncertainty python /app/scripts/precompute_cases.py \
  --cases /evaluation/cases.json --condition C2 --report /tmp/precompute.json

# 2. Deploy reviewer stack (no GPU needed)
docker compose --profile reviewer up -d

# 3. Each reviewer opens their session URL
# http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2
```

> **Note:** `scripts/precompute-all.sh` does not generate artifacts — it only
> verifies that cached results exist (HTTP 409 otherwise). Use
> `precompute_cases.py` (above) to generate.

See [INSTALL.md#reviewer-deployment](INSTALL.md#reviewer-deployment) for details.

## 🔧 Configuration

Key environment variables in `.env`:

```bash
# Database
POSTGRES_USER=medical_imaging
POSTGRES_PASSWORD=<your-strong-password>
POSTGRES_DB=annotations

# CORS (add all client origins)
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8043,http://localhost:8044,http://localhost:3001,http://localhost:58050

# Uncertainty service
UNCERTAINTY_SERVICE_URL=http://localhost:58050
DEFAULT_CASE_CONDITION=C2

# Performance (adjust for your hardware)
OMP_NUM_THREADS=16
CUDA_VISIBLE_DEVICES=-1  # CPU-only mode
```

## 🧪 Testing

```bash
# Verify all services
./scripts/verify-system.ps1

# Run uncertainty service tests
cd servers/uncertainty-service && python -m pytest

# Run MONAI Label tests
cd servers/monai-label && python -m pytest tests/

# Run OHIF extension tests
cd ohif-viewer && npx jest --testPathPattern='extension-uncertainty'

# Check service health
curl http://localhost:3001/health
curl http://localhost:8042/system
curl http://localhost:58050/health
```

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes
4. Push to branch
5. Open a Pull Request

## ⚠️ Limitations & Scope

This is a **research-grade / proof-of-concept** platform. The following are explicitly **out of scope**:

- ❌ Clinical certification (FDA approval, full HIPAA compliance)
- ❌ Large-scale multi-party collaboration (>2 simultaneous users)
- ❌ Training new AI models from scratch
- ❌ Full enterprise PACS workflows and structured reporting

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [OHIF Viewer](https://ohif.org/) — Open-source medical imaging viewer
- [Cornerstone3D](https://www.cornerstonejs.org/) — Medical imaging rendering
- [MONAI Label](https://monai.io/) — AI-assisted annotation
- [Orthanc](https://www.orthanc-server.com/) — DICOM server

## 📬 Contact

- 🐛 Issues: [GitHub Issues](https://github.com/BSeeTech/uncertainty-annotation-apparatus/issues)
