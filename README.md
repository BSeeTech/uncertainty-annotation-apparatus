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
| 🔄 **Condition System** | URL-driven workflow switching (`?reviewer=R01&condition=C2`) — no code changes |
| 🧪 **Placebo Control** | C3 condition with Sobel edge-magnitude overlay indistinguishable from entropy heatmap |
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

# Start all services
docker compose up -d

# Start OHIF Viewer (in a separate terminal)
cd ohif-viewer
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
│   ├── precompute-all.sh           # Batch inference pre-computation for reviewers
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

> **Note on evaluation data:** the MSD Task09 Spleen volumes are not bundled
> with the repository. Run `python evaluation/ct-spleen/install_dataset.py`
> from the repo root to download and verify them (~1.5 GB, with live progress
> and automatic resume — see
> [evaluation/ct-spleen/README.md](evaluation/ct-spleen/README.md#getting-the-dataset)).

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

The platform supports a **condition-routed review workflow**, switchable entirely via URL parameter — no code changes:

| Param | Behaviour | `attachHeatmap` | `importAiMask` | Worklist Policy |
|-------|-----------|:---:|:---:|:---:|
| `C0` | Manual annotation from scratch | ❌ | ❌ | FIFO |
| `C1` | AI pre-annotation, no heatmap | ❌ | ✅ | FIFO |
| `C2` | AI + entropy heatmap + prioritised | ✅ | ✅ | High-uncertainty first |
| `C3` | AI + edge-placebo overlay + prioritised | ✅ (Sobel) | ✅ | High-uncertainty first |
| `C4` | AI + prioritised worklist, no heatmap | ❌ | ✅ | High-uncertainty first |
| `C5` | AI + entropy heatmap, random order | ✅ | ✅ | Randomised |

Conditions C0–C5 let you isolate the effect of AI pre-annotation, uncertainty heatmap display, and worklist ordering in a controlled, reproducible way.

## 🧪 Distributed Reviewer Deployment

For multi-site review workflows:

```bash
# 1. Pre-compute all inferences (GPU required)
./scripts/precompute-all.sh

# 2. Deploy reviewer stack (no GPU needed)
docker compose --profile reviewer up -d

# 3. Each reviewer opens their session URL
# http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2
```

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
