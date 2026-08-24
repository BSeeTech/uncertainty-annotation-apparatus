# Uncertainty Service

FastAPI orchestration service for the Medical Imaging Platform uncertainty workflow. OHIF calls this service for worklist ordering, inference orchestration, event logging, case metadata, and annotation submission. MONAI Label remains responsible for model inference; this service owns persistence and API shape.

## Condition Routing

The service routes inference requests to the correct MONAI Label task based on condition:

| Condition | MONAI Task | Behaviour |
|-----------|-----------|-----------|
| C0 | *(none)* | Manual annotation — no inference |
| C1, C4 | `segmentation` | Single-pass UNet, no uncertainty output |
| C2, C5 | `mcdropout_seg` | MC Dropout (T=16), produces entropy sidecar NIfTI |
| C3 | `saliency_placebo` | Sobel edge-magnitude overlay (placebo control) |

## Endpoints

- `GET  /health` — Server and dependency health
- `GET  /health/ready` — Readiness probe
- `GET  /cases` — List registered cases
- `POST /cases` — Register a new case
- `POST /cases/sync` — Sync cases from Orthanc DICOMweb
- `GET  /worklist` — Scored worklist with policy-based ordering
- `POST /infer/{case_id}` — Run AI inference (condition-routed)
- `POST /events` — Log reviewer action events
- `PUT  /annotations/status/{case_id}/{reviewer_id}` — Update annotation status
- `GET  /annotations/{case_id}/{reviewer_id}` — Get annotation
- `POST /annotations/{case_id}` — Submit annotation with NIfTI mask
- `GET  /results/{case_id}` — Get inference result metadata
- `GET  /files/{case_token}/{filename}` — Download generated NIfTI
- `GET  /analysis/calibration` — Run calibration analysis
- `POST /analysis/temperature` — Fit temperature scaling
- `GET  /monai/{path:path}` — Proxy to MONAI Label

## Architecture

```
app/
├── main.py                 # App factory, all endpoints, schema init, Orthanc sync
├── analysis/
│   ├── calibration.py      # ECE/MCE/ACE/Brier metrics
│   ├── cli.py              # CLI entry point
│   ├── plots.py            # Reliability diagram generation
│   ├── reliability.py      # Reliability binning
│   └── temperature.py      # Temperature scaling
├── annotation_diff.py      # Voxel-wise reviewer vs AI comparison
├── artifact_generation.py  # NIfTI artifact creation and validation
├── orthanc_sync.py         # DICOM study discovery
├── precompute.py           # MONAI bundle pre-processing
├── result_manifest.py      # Checkpoint verification
├── runtime_jobs.py         # Background task management
└── scoring.py              # NIfTI-based uncertainty scoring
tests/
└── test_*.py               # 20 test files, 130+ test functions
```

## Testing

The tests use the evaluation-only database default and never touch a real
database, so no credential setup is required:

```bash
python -m pytest -v --tb=short
python -m pytest --cov=app --cov-report=term-missing
```

On Windows PowerShell:

```powershell
python -m pytest -v --tb=short
```

## Configuration

All configuration is via environment variables (see `app/main.py:32-64`):

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | `uaa-evaluation-only` | Evaluation-only DB password |
| `MONAI_LABEL_URL` | `http://monai-label:8000` | MONAI Label address |
| `ORTHANC_DICOMWEB_URL` | `http://orthanc:8042/dicom-web` | Orthanc DICOMweb |
| `DEFAULT_CASE_CONDITION` | `C2` | Default evaluation condition |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | CORS origins |
| `UNCERTAINTY_OUTPUT_DIR` | `/tmp/uncertainty-service/outputs` | Output directory |
| `PUBLIC_UNCERTAINTY_SERVICE_URL` | `http://localhost:8043/uncertainty` | Public-facing URL |

## Security Notes

- The `ORDER BY` clause uses a frozenset whitelist to prevent SQL injection
- `DATABASE_URL` must be explicitly set or derived from env vars — no hardcoded defaults
- The MONAI proxy (`/monai/{path:path}`) forwards to the internal MONAI Label address
