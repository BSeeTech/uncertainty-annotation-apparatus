# API Reference

Complete documentation for all REST API endpoints across the Uncertainty Annotation Apparatus (UAA) services.

## Table of Contents

- [Uncertainty Service API](#uncertainty-service-api)
  - [Health](#health)
  - [Cases](#cases)
  - [Worklist](#worklist)
  - [Inference](#inference)
  - [Events](#events)
  - [Annotations](#annotations)
  - [Results & Files](#results--files)
  - [MONAI Proxy](#monai-proxy)
- [Collaboration Server API](#collaboration-server-api)
  - [Health & Status](#health--status)
  - [Sessions](#sessions)
- [WebSocket API](#websocket-api)
- [Condition Contract](#condition-contract)

---

## Uncertainty Service API

**Base URL**: `http://localhost:58050`

The uncertainty service is a FastAPI application that orchestrates AI inference, worklist prioritisation, event logging, annotation submission, and calibration analysis. All endpoints are documented in OpenAPI at `http://localhost:58050/docs`.

### Health

#### `GET /health`
Server health and dependency status.

```json
{
  "status": "healthy",
  "database": "healthy",
  "monai_label_reachable": true,
  "monai_label_url": "http://monai-label:8000",
  "version": "0.1.0"
}
```

#### `GET /health/ready`
Readiness probe (returns 200 when DB pool is initialised).

### Cases

#### `GET /cases`
List all known cases with their current condition and status.

#### `POST /cases`
Register a new case manually.

#### `POST /cases/sync`
Sync case list from Orthanc DICOMweb.

### Worklist

#### `GET /worklist`
Returns scored worklist entries for the reviewer.

**Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `policy` | `fifo` \| `high_first` \| `low_first` \| `default` | `fifo` | Ordering policy |
| `limit` | int (1–500) | `50` | Max entries returned |
| `reviewer_id` | str | `null` | Filter by reviewer |

**Response:**
```json
[
  {
    "case_id": "case_001",
    "patient_id": "P001",
    "study_uid": "1.2.3.4",
    "series_uid": "1.2.3.5",
    "score": 0.42,
    "score_band": "medium",
    "status": "ready"
  }
]
```

**Policy behaviour:**
| Policy | Order | Used In |
|--------|-------|---------|
| `fifo` | Arrival order (FIFO) | C0, C1 |
| `high_first` | Highest uncertainty first | C2, C3, C4 |
| `low_first` | Lowest uncertainty first | — |
| `default` | Randomised order | C5 |

### Inference

#### `POST /infer/{case_id}`
Run AI inference for a case. Routes to the correct MONAI Label task based on condition.

**Request Body:**
```json
{
  "condition": "C2",
  "force": false
}
```

**Condition-to-task mapping:**
| Condition | MONAI Label Task | Output |
|-----------|-----------------|--------|
| `C1`, `C4` | `segmentation` | Single-pass UNet, no uncertainty |
| `C2`, `C5` | `mcdropout_seg` | MC Dropout (T=16), entropy sidecar |
| `C3` | `saliency_placebo` | Single-pass UNet + Sobel edge magnitude |

**Response:**
```json
{
  "case_id": "case_001",
  "task": "mcdropout_seg",
  "segmentation_url": "/files/case_001/segmentation.nii.gz",
  "uncertainty_url": "/files/case_001/uncertainty.nii.gz",
  "model_version": "mcdropout_seg",
  "num_samples": 16,
  "score": 0.42,
  "score_p95": 0.87,
  "score_fraction_above": 0.15,
  "score_mean_all": 0.31,
  "band": "medium",
  "result_url": "/results/case_001?condition=C2",
  "cache_hit": false
}
```

### Events

#### `POST /events`
Log one or more reviewer actions (instrumentation for session analysis).

```json
{
  "events": [
    {
      "case_id": "case_001",
      "reviewer_id": "R01",
      "condition": "C2",
      "event_type": "case_open",
      "payload": {},
      "client_ts": "2026-01-15T10:30:00Z"
    }
  ]
}
```

**Event types:** `case_open`, `case_close`, `slice_change`, `viewport_change`, `heatmap_toggle`, `opacity_change`, `accept`, `reject`, `edit_start`, `edit_end`, `snapshot`, `submit`, `escalate`, `structure_focus`

### Annotations

#### `PUT /annotations/status/{case_id}/{reviewer_id}`
Update annotation status.

```json
{
  "condition": "C2",
  "status": "edited"
}
```

**Status values:** `accepted`, `edited`, `rejected`, `escalated`, `in_review`

#### `GET /annotations/{case_id}/{reviewer_id}`
Retrieve submitted annotation.

#### `POST /annotations`
Submit annotation with NIfTI mask. Multipart form with segmentation file + metadata.

### Results & Files

#### `GET /results/{case_id}`
Get inference result metadata including URLs for segmentation and uncertainty NIfTIs.

#### `GET /files/{case_token}/{filename}`
Download a generated NIfTI file (segmentation, uncertainty, foreground probability).

#### `GET /files/{case_token}/{condition}/{filename}`
Download a generated NIfTI file for a specific condition.

### MONAI Proxy

#### `ANY /monai/{path:path}`
Proxies requests to the MONAI Label server (internal Docker network). Used by the OHIF viewer to reach `http://monai-label:8000/...` through the uncertainty service, since the browser cannot resolve the Docker-internal hostname.

---

## Collaboration Server API

**Base URL**: `http://localhost:3001`

### Health & Status

#### `GET /health`

```json
{
  "status": "healthy",
  "database": "healthy",
  "activeSessions": 0,
  "activeConnections": 0
}
```

### Sessions

#### `POST /api/sessions`
Create a new collaboration session.

**Request Body:**
```json
{
  "studyInstanceUID": "1.2.3.4",
  "userId": "user_01"
}
```

**Response:** `{ "sessionId": "session_...", "studyInstanceUID": "...", "createdAt": "..." }`

#### `GET /api/sessions/:sessionId`
Get session details, including annotations and active users.

#### `GET /api/sessions`
List active sessions (up to 50, most recent first).

#### `POST /api/sessions/:sessionId/close`
Close a session and notify all connected users.

---

## WebSocket API

**Endpoint**: `ws://localhost:3001`

### Connection
```javascript
const socket = io('http://localhost:3001', {
  query: { sessionId: '...', userId: '...' }
});
```

### Session Events
| Event | Direction | Payload |
|-------|-----------|---------|
| `session:join` | server → client | `{ userId, displayName }` |
| `session:leave` | server → client | `{ userId }` |
| `viewport:sync` | client ↔ server | `{ camera, tools, slice }` |
| `annotation:update` | client ↔ server | `{ toolType, data }` |
| `segmentation:update` | client ↔ server | `{ segmentIndex, operation }` |
| `role:change` | server → client | `{ userId, role }` |
| `session:closed` | server → client | `{ sessionId, closedAt }` |

---

## Condition Contract

The condition parameter (`?condition=C2`) controls all behavioural differences between conditions. The mapping is enforced in two places:

### Server-side (`servers/uncertainty-service/app/main.py`)
```python
task = {
    "C1": "segmentation",     # AI-only, no uncertainty
    "C4": "segmentation",     # worklist-only (also no uncertainty)
    "C2": "mcdropout_seg",    # MC Dropout with entropy
    "C5": "mcdropout_seg",    # heatmap-only (also MC Dropout)
    "C3": "saliency_placebo", # Sobel edge placebo
}.get(condition, "segmentation")
```

### Client-side (`ohif-viewer/modes/uncertainty-review/src/commands/openUncertaintyCase.ts`)
```typescript
const runInference = args.condition !== 'C0';
const importAiSegmentation = args.condition !== 'C0';
const attachHeatmap = args.condition === 'C2' || args.condition === 'C3' || args.condition === 'C5';
```
