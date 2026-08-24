# Thesis-to-repository map

This page connects the research narrative in the thesis to the current source
tree. The thesis explains why the apparatus was designed and reports the
evaluation snapshot captured for the dissertation. The repository describes
what the checked-out software currently does. When exact test counts, routes,
or deployment details differ, use the current code and tests operationally and
cite the thesis only for its recorded study claims.

## Research idea

The apparatus investigates whether exposing predictive uncertainty can improve
human review of AI-generated medical-image segmentations. MC Dropout produces
multiple stochastic predictions; their mean predictive entropy becomes both a
voxel-level `magma` heatmap and an input to case-level prioritisation.

The implemented comparison is:

| Condition | Reviewer experience | Current status |
|---|---|---|
| C0 | Manual annotation | Implemented |
| C1 | AI pre-annotation without heatmap | Implemented |
| C2 | AI pre-annotation, entropy heatmap, prioritised worklist | Implemented |
| C3-C5 | Proposed factorial extensions | Scaffolding; not runnable |

The thesis explicitly states that its reviewer-level evaluation data is
synthetic and that no human-participant study was conducted. Do not describe
those results as clinical validation or observed radiologist performance.

## Server-side implementation (thesis Chapter 5)

| Thesis concept | Current repository location |
|---|---|
| MC Dropout inference and predictive entropy | `servers/monai-label/lib/infers/mcdropout_seg.py` |
| Checkpoint identity and configuration | `servers/monai-label/lib/model_metadata.py`, `servers/monai-label/model/checkpoint.lock.json` |
| FastAPI orchestration and database schema | `servers/uncertainty-service/app/main.py` |
| Case-level scoring and bands | `servers/uncertainty-service/app/scoring.py` |
| Annotation difference calculation | `servers/uncertainty-service/app/annotation_diff.py` |
| Orthanc discovery | `servers/uncertainty-service/app/orthanc_sync.py` |
| Pre-computed artifact workflow | `servers/uncertainty-service/app/precompute.py`, `app/artifact_generation.py` |
| Calibration and temperature scaling | `servers/uncertainty-service/app/analysis/` |
| Persistent collaboration schema | `scripts/init-db.sql` |

The thesis records an earlier snapshot with 106 server tests, one known
deployment-contract failure, and no separate readiness check. In this checkout,
the server suite has 111 passing tests when the required database environment is
provided, and `GET /health/ready` is implemented and tested.

## OHIF integration (thesis Chapter 6)

| Thesis concept | Current repository location |
|---|---|
| Workflow service and condition gates | `ohif-viewer/extensions/extension-uncertainty/src/services/UncertaintyService.ts` |
| Entropy volume rendering | `ohif-viewer/extensions/extension-uncertainty/src/services/HeatmapRenderer.ts` |
| Sequential `magma` transfer function | `ohif-viewer/extensions/extension-uncertainty/src/utils/transferFunctions.ts` |
| Worklist, uncertainty, and submission panels | `ohif-viewer/extensions/extension-uncertainty/src/panels/` |
| Buffered reviewer event logging | `ohif-viewer/extensions/extension-uncertainty/src/services/EventLogger.ts` |
| OHIF/Cornerstone adapters | `ohif-viewer/modes/uncertainty-review/src/adapter/` |
| Session URL and condition plan | `ohif-viewer/modes/uncertainty-review/src/sessionConfig.ts` |
| Case-opening orchestration | `ohif-viewer/modes/uncertainty-review/src/commands/openUncertaintyCase.ts` |

The custom extension deliberately avoids direct Cornerstone internals. The
mode supplies adapters so OHIF version-specific behavior stays at the host
boundary. Reviewer hotkeys defined by the current mode are `u` (heatmap), `a`
(accept), `r` (reject), and `Shift+u` (refresh worklist).

## Evaluation and reproducibility

The reproducible CT spleen workflow lives in `evaluation/ct-spleen/`. Its README
is the authoritative execution order for dataset installation, case
registration, artifact generation, validation, and reporting. Generated and
synthetic study files are intentionally excluded from version control and can
be regenerated from the scripts and frozen configuration.

The apparatus is a research prototype using public, pseudonymised research
data. It is not clinically validated, is not a medical device, and has not
undergone the governance, conformity assessment, or prospective participant
study required for clinical deployment.

