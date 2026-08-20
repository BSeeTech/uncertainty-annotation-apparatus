# Developer Guide

Technical documentation for extending and customizing the Uncertainty Annotation Apparatus (UAA).

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Condition System](#condition-system)
- [Server-Side Development](#server-side-development)
  - [Uncertainty Service](#uncertainty-service)
  - [MONAI Label Inference Tasks](#monai-label-inference-tasks)
- [Client-Side Development](#client-side-development)
  - [Extension Architecture](#extension-architecture)
  - [Adapter Pattern](#adapter-pattern)
  - [Condition Gating](#condition-gating)
  - [Snapshot Service](#snapshot-service)
- [Analysis Scripts](#analysis-scripts)
- [Testing](#testing)
- [Database Schema](#database-schema)
- [Debugging](#debugging)

---

## Architecture Overview

### System Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      OHIF Viewer (React/TypeScript)                  │    │
│  │  ┌─────────────┐  ┌──────────────────┐  ┌────────────┐  ┌────────┐  │    │
│  │  │Collaboration│  │   Uncertainty    │  │Cornerstone │  │ Default│  │    │
│  │  │ Extension   │  │   Extension      │  │ Extension  │  │Ext.    │  │    │
│  │  └─────────────┘  └──────────────────┘  └────────────┘  └────────┘  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────────────────┤
│                          SERVICE LAYER (Docker)                              │
├───────────────────┬──────────────────┬──────────────────┬───────────────────┤
│ Collaboration     │  Uncertainty     │  MONAI Label     │  Orthanc PACS    │
│ (Node.js/SocketIO)│  (FastAPI)       │  (Python/MONAI)  │  (DICOMweb)      │
└───────────────────┴──────────────────┴──────────────────┴───────────────────┘
├─────────────────────────────────────────────────────────────────────────────┤
│                           DATA LAYER (PostgreSQL)                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Two-package split** (extension vs. mode) — The uncertainty feature is split into `extension-uncertainty` (services, panels, state) and `mode-uncertainty-review` (viewer lifecycle, commands, adapters). This follows OHIF v3 conventions where extensions own data, modes own workflow.

2. **Adapter pattern** — `CornerstoneAdapter` and `SegmentationExportAdapter` wrap Cornerstone3D's complex viewport API behind narrow interfaces (6 methods each). This isolates the uncertainty extension from Cornerstone3D version changes.

3. **Condition gating at the service layer** — All behavioural differences between C0–C5 are enforced in `UncertaintyService.ts` and `openUncertaintyCase.ts`, not in individual React components. This prevents condition leaks.

4. **Share the same checkpoint** — C1 (deterministic) and C2 (MC Dropout) use the same pretrained model. C3 (saliency placebo) also uses the same model but replaces entropy with Sobel edge magnitude.

## Condition System

The platform routes behaviour through six URL-driven conditions that isolate the effects of AI pre-annotation, uncertainty heatmap display, and worklist ordering:

| ID | Name | `runInference` | `importAiMask` | `attachHeatmap` | Worklist Policy | MONAI Task |
|----|------|:---:|:---:|:---:|:---:|:---:|
| C0 | Manual | ❌ | ❌ | ❌ | FIFO | — |
| C1 | AI-only | ✅ | ✅ | ❌ | FIFO | `segmentation` |
| C2 | Full uncertainty | ✅ | ✅ | ✅ (entropy) | High-first | `mcdropout_seg` |
| C3 | Placebo saliency | ✅ | ✅ | ✅ (Sobel) | High-first | `saliency_placebo` |
| C4 | Worklist-only | ✅ | ✅ | ❌ | High-first | `segmentation` |
| C5 | Heatmap-only | ✅ | ✅ | ✅ (entropy) | Random | `mcdropout_seg` |

### Adding a New Condition

1. **Types** (`ohif-viewer/extensions/extension-uncertainty/src/types.ts`): Add to the `Condition` union type
2. **Server routing** (`servers/uncertainty-service/app/main.py`): Add to the task mapping dict
3. **Plan builder** (`ohif-viewer/modes/uncertainty-review/src/commands/openUncertaintyCase.ts`): Update `runInference`, `importAiSegmentation`, `attachHeatmap` logic
4. **Session config** (`ohif-viewer/modes/uncertainty-review/src/sessionConfig.ts`): Update `VALID_CONDITIONS` set
5. **Validation** (`ohif-viewer/extensions/extension-uncertainty/src/services/UncertaintyService.ts`): Update the condition validation array
6. **Panels**: Update gating in `PanelUncertainty.tsx`, `PanelWorklist.tsx`, `PanelSubmission.tsx`

## Server-Side Development

### Uncertainty Service

Stack: **FastAPI + asyncpg + NIfTI/Nibabel**

```
servers/uncertainty-service/app/
├── main.py              # App factory, all routes, schema init
├── analysis/
│   ├── calibration.py   # ECE/MCE/ACE/Brier metrics
│   ├── reliability.py   # Reliability binning
│   ├── temperature.py   # Temperature scaling (optimisation)
│   └── plots.py         # Reliability diagram generation
│   └── cli.py           # CLI entry point
├── annotation_diff.py   # Voxel-wise reviewer-vs-AI comparison
├── artifact_generation.py
├── orthanc_sync.py      # DICOM study discovery from Orthanc
├── precompute.py        # MONAI bundle pre-processing
├── result_manifest.py   # Checkpoint verification
├── runtime_jobs.py      # Background task management
└── scoring.py           # NIfTI-based uncertainty scoring
```

Key architectural notes:
- All routes are in `main.py` (17 documented endpoints plus the `/monai/{path:path}` proxy)
- The MONAI Label proxy (`/monai/{path:path}`) forwards requests to the internal MONAI Label container
- Pre-computed artifacts are cached on disk at `UNCERTAINTY_OUTPUT_DIR`

#### Adding a New Endpoint

```python
@app.post("/my-new-endpoint/{case_id}")
async def my_endpoint(case_id: str):
    pool = await get_pool()
    # ... business logic
    return {"result": "ok"}
```

### MONAI Label Inference Tasks

Tasks are registered in `servers/monai-label/main.py` and follow the MONAI Label `BasicInferTask` pattern.

#### Standard Task (C1/C4)
`lib/infers/segmentation.py` — single forward pass, argmax, returns segmentation NIfTI.

#### MC Dropout Task (C2/C5)
`lib/infers/mcdropout_seg.py` — runs T=16 stochastic forward passes with dropout active, computes per-voxel predictive entropy, returns a NIfTI bundle (`.zip` with `segmentation.nii.gz` + `uncertainty.nii.gz` + `foreground_probability.nii.gz` + `result.json`).

#### Saliency Placebo Task (C3)
`lib/infers/saliency_placebo.py` — single forward pass, then computes Sobel edge magnitude of the hard segmentation (Gaussian-blurred, normalised to entropy range [0, 4.5]). Returns the same .zip bundle format as MC Dropout, but the `uncertainty.nii.gz` file contains edges instead of entropy.

## Client-Side Development

### Extension Architecture

The uncertainty extension follows OHIF v3's extension pattern:

```
ohif-viewer/extensions/extension-uncertainty/
├── src/
│   ├── index.tsx              # Extension entry: preRegistration, getCommandsModule, getPanelModule
│   ├── services/
│   │   ├── UncertaintyService.ts   # Central state machine (31KB)
│   │   ├── WorklistApi.ts          # REST client for worklist/inference endpoints
│   │   ├── SubmissionApi.ts        # Multipart annotation submission
│   │   ├── HeatmapRenderer.ts      # Cornerstone3D volume actor for entropy overlay
│   │   ├── EventLogger.ts          # Buffered sendBeacon event streaming
│   │   └── SnapshotService.ts      # Periodic segmentation state snapshots (5s)
│   ├── panels/
│   │   ├── PanelWorklist.tsx       # Scored worklist with policy selector
│   │   ├── PanelUncertainty.tsx    # Heatmap opacity/visibility controls
│   │   └── PanelSubmission.tsx     # Accept/Edit/Reject decision panel
│   ├── hooks/
│   │   └── useUncertaintyState.ts  # React hook for reactive state subscription
│   └── __tests__/                  # 11 test files, 50+ it() blocks
```

### Adapter Pattern

The uncertainty mode uses two adapters to decouple from Cornerstone3D:

```typescript
// Narrow interface — 6 methods
interface CornerstoneAdapter {
  getActiveViewportId(): string;
  getSliceIndex(viewportId: string): number;
  setSliceIndex(viewportId: string, index: number): void;
  getVolumeIds(): string[];
  setVolumeVisible(volumeId: string, visible: boolean): void;
  getActor(volumeId: string): any;
}

// Used in tests — fully mockable
const mockAdapter: CornerstoneAdapter = {
  getActiveViewportId: () => 'viewport-1',
  // ...
};
```

### Condition Gating

Conditions are enforced in `UncertaintyService.ts`:

```typescript
applySessionFromQuery(query: string): boolean {
  const params = new URLSearchParams(query);
  const condition = params.get('condition') as Condition | null;
  if (!['C0','C1','C2','C3','C4','C5'].includes(condition)) return false;
  this.setSession({ reviewerId, condition });
  return true;
}
```

React panels use the condition from the shared state:

```typescript
const hasHeatmap = state.session?.condition === 'C2' 
  || state.session?.condition === 'C3' 
  || state.session?.condition === 'C5';
```

### Snapshot Service

The `SnapshotService` captures periodic snapshots of the segmentation state:

```typescript
const snapshots = new SnapshotService(uncertaintyService, eventLogger, ...);
snapshots.start(); // 5-second interval
snapshots.stop();  // clean up on unmount
```

Each snapshot captures: voxel count, component count, slice index, active tool, zoom/pan. Snapshots with no meaningful change since the last capture are dropped. Emitted as `snapshot` events through the EventLogger.

## Analysis Scripts

Located in `scripts/`:

### Edit Reversion Analysis
```bash
python scripts/analyze_reversions.py \
  --db-url postgresql://user:pass@host/db \
  --output /tmp/reversion-report.json
```
Detects sequences where a reviewer edited a region and later reverted. Computes per-reviewer trust trajectories and automation-bias signals by comparing reversion rates in high- vs. low-uncertainty regions.

### Inter-Rater Agreement
```bash
python scripts/analyze_interrater.py \
  --fixture annotations.json \
  --output /tmp/interrater-report.json
```
Computes pairwise Dice similarity for the same case in the same condition across reviewers. Compares agreement across conditions to detect convergence or divergence signals from uncertainty visualisation.

### Pre-computation
```bash
./scripts/precompute-all.sh
```
Generates all case×condition inference artifacts offline. Required before deploying the reviewer Docker profile.

## Testing

### Server-Side Tests

Uncertainty Service (15 test files, 106 test functions):
```bash
cd servers/uncertainty-service
python -m pytest -v              # All tests
python -m pytest tests/test_scoring.py  # Single file
python -m pytest -k "calibration" # By keyword
```

MONAI Label tests:
```bash
cd servers/monai-label
python -m pytest tests/
```

### Client-Side Tests

OHIF extension tests (13 test files, 118 test cases):
```bash
cd ohif-viewer
npx jest --testPathPattern='extension-uncertainty'
npx jest --testPathPattern='PanelUncertainty'
```

Mode tests (7 test files):
```bash
cd ohif-viewer
npx jest --testPathPattern='uncertainty-review'
npx jest --testPathPattern='openUncertaintyCase'
```

### Test Fixtures

The uncertainty service uses:
- `tests/fixtures/` — Pre-computed NIfTI files for scoring/banding tests
- Synthetic data generators for calibration tests (perfectly calibrated, overconfident, underconfident)

### Bugs Caught by Tests

The test suite has historically caught:
- NIfTI byte-order mismatches between nibabel and Cornerstone3D
- Off-by-one in entropy band boundaries
- Race conditions in worklist refresh during inference
- sendBeacon payload size exceeding browser limits

## Database Schema

```sql
-- Core tables
CREATE TABLE cases (
    case_id TEXT PRIMARY KEY,
    patient_id TEXT,
    study_uid TEXT NOT NULL,
    series_uid TEXT NOT NULL,
    condition TEXT NOT NULL DEFAULT 'C2',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE uncertainty_scores (
    case_id TEXT PRIMARY KEY REFERENCES cases(case_id),
    score DOUBLE PRECISION,
    band TEXT,
    score_p95 DOUBLE PRECISION,
    score_fraction_above DOUBLE PRECISION,
    uncertainty_url TEXT,
    segmentation_url TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE annotation_status (
    case_id TEXT NOT NULL REFERENCES cases(case_id),
    reviewer_id TEXT NOT NULL,
    condition TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    annotation_path TEXT,
    submitted_at TIMESTAMPTZ,
    PRIMARY KEY (case_id, reviewer_id, condition)
);

CREATE TABLE events (
    id BIGSERIAL PRIMARY KEY,
    case_id TEXT NOT NULL,
    reviewer_id TEXT NOT NULL,
    condition TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB,
    client_ts TIMESTAMPTZ,
    server_ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Debugging

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `POSTGRES_PASSWORD must be set` | Missing env var | Set `POSTGRES_PASSWORD` in `.env` |
| MONAI Label cannot connect to Orthanc | Startup race | MONAI Label has a 20s sleep before connecting |
| Heatmap not visible in C2 | Volume actor not initialised | Check browser console for `heatmapError` |
| Events not logged | sendBeacon blocked by CORS | Verify `ALLOWED_ORIGINS` includes the OHIF origin |
| Worklist returns empty | No cases synced from Orthanc | Call `POST /cases/sync` or register cases manually |

### Logs
```bash
# All services
docker compose logs -f uncertainty-service
docker compose logs -f monai-label

# Python debug logging
export LOG_LEVEL=DEBUG
```

### Health Checks
```bash
# Uncertainty service
curl http://localhost:58050/health | python -m json.tool

# Check database directly
docker exec medical-postgres psql -U medical_imaging -d annotations \
  -c "SELECT COUNT(*) FROM events"
```
