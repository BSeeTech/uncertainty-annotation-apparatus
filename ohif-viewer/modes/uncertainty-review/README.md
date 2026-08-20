# @thesis/mode-uncertainty-review

OHIF v3 mode for the thesis project. This is the final frontend-side piece: it plugs `@thesis/extension-uncertainty` into a host OHIF application, provides the real `CornerstoneAdapter` and `SegmentationExportAdapter` implementations, and orchestrates the "open this case" command that bridges the worklist and the viewer.

## Condition Routing

The mode creates separate display names and route suffixes for each condition:

| Condition | Display Name | Route |
|-----------|-------------|-------|
| C0 | Manual | `manual-review` |
| C1 | MONAILabel | `monailabel-review` |
| C2 | Uncertainty-Guided Review | `uncertainty-review` |
| C3 | Placebo Saliency | `placebo-saliency` |
| C4 | Prioritised Worklist | `prioritised-worklist` |
| C5 | Heatmap Only | `heatmap-only` |

## Architecture

```
src/
├── index.ts                          # Mode factory: mode definition, toolbar, viewport, panels
├── sessionConfig.ts                  # URL parsing: ?reviewer=R01&condition=C2
├── commands/
│   └── openUncertaintyCase.ts        # buildOpenPlan + executeOpen (C0–C5 paths)
├── adapter/
│   ├── createCornerstoneAdapter.ts   # Real Cornerstone3D viewport adapter (6 methods)
│   └── createSegmentationExportAdapter.ts  # NIfTI writer for annotation export
└── __tests__/
    ├── mode.test.ts                  # Mode lifecycle + registration
    ├── sessionConfig.test.ts         # URL parsing (valid, invalid, edge cases)
    ├── openUncertaintyCase.test.ts   # All C0–C5 paths + error conditions
    └── adapter/
        ├── CornerstoneAdapter.test.ts
        └── SegmentationExportAdapter.test.ts
```

## The Adapter Pattern

Two narrow interfaces decouple the uncertainty extension from Cornerstone3D:

### CornerstoneAdapter (6 methods)
```typescript
interface CornerstoneAdapter {
  getActiveViewportId(): string;
  getSliceIndex(viewportId: string): number;
  setSliceIndex(viewportId: string, index: number): void;
  getVolumeIds(): string[];
  setVolumeVisible(volumeId: string, visible: boolean): void;
  getActor(volumeId: string): any;
}
```

### SegmentationExportAdapter (3 methods)
```typescript
interface SegmentationExportAdapter {
  exportToNifti(segmentationId: string): Promise<Uint8Array>;
  getSegmentationIds(): string[];
  getLabelmapVolumeId(segmentationId: string): string | null;
}
```

## The openUncertaintyCase Command

This is the single most important piece of orchestration logic. It has two parts:

### `buildOpenPlan` (pure function, no side effects)

```typescript
function buildOpenPlan(args: {
  caseId: string;
  entry: WorklistEntry | null;
  condition: Condition | null;
}): OpenPlan | OpenPlanError
```

Returns a plan with three flags based on condition:
```typescript
{
  runInference: boolean;          // false for C0
  importAiSegmentation: boolean;  // false for C0
  attachHeatmap: boolean;         // true for C2, C3, C5
}
```

### `executeOpen` (side-effectful)

Executes the plan against the live OHIF services:
1. Loads the study into the viewport
2. Resolves the volume
3. If `runInference`: calls the uncertainty service
4. If `importAiSegmentation`: imports the AI mask via `SegmentationImportAdapter`
5. If `attachHeatmap`: loads the entropy/placebo volume via `HeatmapRenderer`

## URL Session Config

The mode parses reviewer session from the URL:
```
http://localhost:3000/uncertainty-review?reviewer=R03&condition=C2&caseId=case_001
```

Parameters:
- `reviewer` — required, alphanumeric + `-_.`, max 32 chars
- `condition` — required, one of C0–C5
- `caseId` — optional, pre-selects a case

Invalid parameters cause the mode to show a descriptive error instead of silently failing.

## Testing

```bash
cd ohif-viewer
npx jest --testPathPattern='uncertainty-review'
npx jest --testPathPattern='openUncertaintyCase'
npx jest --testPathPattern='sessionConfig'
```
