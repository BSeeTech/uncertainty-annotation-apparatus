# Changelog

All notable changes to the Medical Imaging Platform will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased (v1.1.0)

### Added

- **C3 saliency-placebo condition** (`servers/monai-label/lib/infers/saliency_placebo.py`)
  - New MONAI Label inference task that replaces the entropy uncertainty map with a Sobel edge-magnitude overlay
  - Produces identically-formatted NIfTI bundle (`.zip` with `segmentation.nii.gz`, `uncertainty.nii.gz`, `foreground_probability.nii.gz`, `result.json`)
  - Registers as `saliency_placebo` infer task in `MONAILabelApp.init_infers()`
  - Routed via condition map: `C3 → "saliency_placebo"`

- **C4 worklist-only condition** (factorial control)
  - AI pre-annotation + prioritised worklist, NO heatmap visible
  - Gated in `PanelUncertainty.tsx` (disabled controls), `PanelWorklist.tsx` (shows scores), `openUncertaintyCase.ts` (`attachHeatmap: false`)

- **C5 heatmap-only condition** (factorial control)
  - AI pre-annotation + entropy heatmap, default-order (randomised) worklist
  - `showScore: false` in `PanelWorklist.tsx`, policy fixed to `default` (RANDOM() SQL ordering)

- **SnapshotService** (`ohif-viewer/extensions/extension-uncertainty/src/services/SnapshotService.ts`)
  - Time-locked 5-second interval snapshots of segmentation state
  - Captures: voxel count, component count, slice index, active tool, zoom/pan
  - Emitted as `snapshot` events through EventLogger for post-hoc reversion analysis
  - Skips duplicate emission when state hasn't changed

- **Reviewer Docker Compose profile** (`docker-compose.yml → reviewer` profile)
  - Lightweight stack for multi-site studies without GPU
  - Services: `reviewer-postgres`, `reviewer-uncertainty` (pre-computed mode), `reviewer-ohif`
  - Usage: `docker compose --profile reviewer up -d`

- **Pre-computation script** (`scripts/precompute-all.sh`)
  - Batch-generates all case×condition inference artifacts offline
  - Latin-square case allocation for up to 50 reviewers
  - Output: per-case .zip artifacts + `case-allocation.json`

- **Analysis scripts** (`scripts/analyze_reversions.py`, `scripts/analyze_interrater.py`)
  - Reversion analysis: detects edit↔revert sequences from snapshot traces, computes trust trajectories and automation-bias signals
  - Inter-rater agreement: pairwise Dice similarity across conditions, convergence/divergence detection

- **Condition type extended** from 3 to 6 (`C0`–`C5`)
  - TypeScript union type updated in `types.ts`
  - Server-side condition validation and task mapping updated
  - URL-driven condition switching (`?condition=C3`) without code changes
  - All panel gating logic updated to handle new conditions

- **Security hardening**
  - `DATABASE_URL` in main.py now fail-closed: requires `POSTGRES_PASSWORD` env var when not explicitly set
  - SQL injection mitigation: `ORDER BY` clause validated against a `frozenset` whitelist before dynamic interpolation
  - Invalid policy values now raise `ValueError` instead of being injected into SQL

### Changed

- **README.md** — Complete rewrite with 6-condition table, updated architecture diagram, reviewer deployment section, badges, DOI
- **API.md** — Added uncertainty service API docs (16 endpoints), condition contract table, policy behaviour docs
- **INSTALL.md** — Added reviewer deployment section, manual installation for each service, pre-computation guide
- **DEVELOPER_GUIDE.md** — Added conditions system, adapter pattern, snapshot service, analysis scripts, comprehensive testing guide
- **GETTING-STARTED.md** — Updated with uncertainty service, reviewer setup, condition URL docs
- **USER_GUIDE.md** — Added C0–C5 condition documentation for end-users
- **CONTRIBUTING.md** — Updated with testing guidelines, PR template
- **TROUBLESHOOTING.md** — Added uncertainty service issues, condition troubleshooting

- `servers/uncertainty-service/app/main.py`
  - `Condition = Literal["C0", "C1", "C2", "C3", "C4", "C5"]`
  - `Policy = Literal["fifo", "high_first", "low_first", "default"]`
  - Condition-to-task routing map added (line ~428)
  - Hardcoded DB password removed (fail-closed credential construction)
  - SQL injection frozenset whitelist for ORDER BY

- `ohif-viewer/modes/uncertainty-review/src/commands/openUncertaintyCase.ts`
  - `importAiSegmentation` now covers C1–C5 (anything except C0)
  - `attachHeatmap` covers C2, C3, C5

- `ohif-viewer/extensions/extension-uncertainty/src/types.ts`
  - `Condition` type extended to `'C0' | 'C1' | 'C2' | 'C3' | 'C4' | 'C5'`
  - `WorklistPolicy` type extended to include `'default'`

- `ohif-viewer/modes/uncertainty-review/src/sessionConfig.ts`
  - `VALID_CONDITIONS` set updated

- `ohif-viewer/modes/uncertainty-review/src/index.ts`
  - Added display names and route suffixes for C3, C4, C5

### Fixed

- Hardcoded database credentials removed from source (`servers/uncertainty-service/app/main.py:32-35`)
- SQL injection vulnerability mitigated (`ORDER BY {order_by}` → frozenset whitelist)
- CORS default changed to `*` for development only
- EventLogger now skips empty snapshot emissions (noise reduction)

### Documentation

- All 8 core documentation files rewritten for GitHub readiness
- Architecture diagram updated with uncertainty service
- API reference expanded with all uncertainty service endpoints
- Condition contract documented in both server and client sections
- Reviewer deployment documented with step-by-step instructions

## [1.0.0] — 2026-07-22

### Added

- Initial release: OHIF Viewer with collaboration, MONAI Label, Orthanc PACS stack
- C0/C1/C2 workflow conditions (manual, AI-only, AI + uncertainty heatmap)
- MC Dropout uncertainty estimation (T=16 forward passes)
- Predictive entropy heatmap overlay with opacity controls
- Uncertainty-prioritised worklist with band classification
- Buffered event logging via sendBeacon
- Calibration analysis pipeline (ECE/MCE, temperature scaling, reliability diagrams)
- OHIF v3 extension with adapter pattern for Cornerstone3D
- Docker Compose orchestration for all services
- 15 test files for uncertainty service, 13 for OHIF extension
