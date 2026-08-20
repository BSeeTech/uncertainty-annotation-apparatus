# @thesis/extension-uncertainty

OHIF v3 extension that surfaces voxel-level uncertainty heatmaps, a prioritised worklist, event logging, and segmentation snapshots for the thesis project.

## Condition Gating

The extension supports 6 evaluation conditions (C0–C5) that control what UI elements are visible:

| Behaviour | C0 | C1 | C2 | C3 | C4 | C5 |
|-----------|:--:|:--:|:--:|:--:|:--:|:--:|
| AI mask import | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Heatmap visible | ❌ | ❌ | ✅ | ✅ (Sobel) | ❌ | ✅ |
| Score column in worklist | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ |
| Policy picker | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ |
| Accept AI mask | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Module Layout

```
src/
├── index.tsx              # Extension entry: preRegistration, commands, panels
├── types.ts               # Condition, WorklistPolicy, ScoreBand, EventType
├── services/
│   ├── UncertaintyService.ts   # Central state machine (31KB, 700+ lines)
│   ├── WorklistApi.ts          # REST client (fetch + error classification)
│   ├── SubmissionApi.ts        # Multipart annotation submission
│   ├── HeatmapRenderer.ts      # Cornerstone3D volume actor + colormap
│   ├── EventLogger.ts          # Buffered sendBeacon event stream
│   └── SnapshotService.ts      # 5-second periodic segmentation snapshots
├── panels/
│   ├── PanelWorklist.tsx       # Scored case list with policy selector
│   ├── PanelUncertainty.tsx    # Heatmap opacity/visibility controls
│   └── PanelSubmission.tsx     # Accept/Edit/Reject decision panel
├── hooks/
│   └── useUncertaintyState.ts  # Reactive state subscription hook
└── __tests__/
    ├── UncertaintyService.test.ts   # 11 test blocks, 50+ assertions
    ├── PanelSubmission.test.tsx      # Condition-gated rendering
    ├── PanelUncertainty.test.tsx     # Heatmap control rendering
    ├── PanelWorklist.test.tsx        # Worklist display logic
    ├── WorklistApi.test.ts           # HTTP client + error handling
    ├── SubmissionApi.test.ts         # Multipart form + status updates
    └── EventLogger.test.ts           # sendBeacon buffering + condition scoping
```

## Key Architectural Decisions

### 1. Service-layer condition gating

All condition-dependent behaviour is enforced in `UncertaintyService.ts` and consumed by panels through a shared state bus, not in individual React components. This prevents condition leaks and makes the gating testable without rendering.

### 2. Graceful degradation

Every service has a `createMissing*` stub. If the backend config is absent, the extension loads without crashing — it simply shows empty panels with explanatory messages instead of error screens.

### 3. Adapter pattern

The extension does not import Cornerstone3D directly. `CornerstoneAdapter` (6 methods) and `SegmentationExportAdapter` wrap the viewport API behind narrow, mockable interfaces defined in the mode package.

### 4. Snapshot Service

The `SnapshotService` captures periodic 5-second snapshots of the segmentation state (voxel count, component count, slice position, active tool). Snapshots with no change are dropped to reduce noise. The data enables post-hoc reversion analysis and trust-trajectory computation.

## Testing

```bash
cd ohif-viewer
npx jest --testPathPattern='extension-uncertainty'
npx jest --testPathPattern='extension-uncertainty/PanelUncertainty'
```

## Dependencies

- **Phase 1** (`monai_label_app`) — provides `mcdropout_seg` and `saliency_placebo` inference tasks
- **Phase 2** (`uncertainty_service`) — provides the FastAPI endpoints (`/infer/{id}`, `/worklist`, `/events`, `/annotations`)
- **OHIF v3** — `@ohif/core`, `@ohif/ui`, `@ohif/extension-default`, `@ohif/extension-cornerstone`
