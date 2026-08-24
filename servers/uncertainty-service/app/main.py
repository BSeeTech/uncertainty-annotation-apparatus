import os
import io
import gzip
import json
import struct
import zipfile
import asyncio
import logging
import uuid
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Literal
from urllib.parse import quote, urlencode

import asyncpg
import httpx
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.orthanc_sync import discover_cases
from app.scoring import compute_uncertainty_scores
from app.annotation_diff import diff_files, load_nifti
from app.artifact_generation import current_generation_dir
from app.result_manifest import (
    ManifestValidationError,
    load_manifest,
    manifest_to_inference_response,
)


DATABASE_URL = os.getenv("DATABASE_URL")
if DATABASE_URL is None:
    _db_user = os.getenv("POSTGRES_USER", "medical_imaging")
    # Evaluation-apparatus default. Override before exposing this service.
    _db_pass = os.getenv("POSTGRES_PASSWORD", "uaa-evaluation-only")
    _db_host = os.getenv("POSTGRES_HOST", "postgres")
    _db_name = os.getenv("POSTGRES_DB", "annotations")
    DATABASE_URL = f"postgresql://{_db_user}:{_db_pass}@{_db_host}:5432/{_db_name}"
MONAI_LABEL_URL = os.getenv("MONAI_LABEL_URL", "http://monai-label:8000").rstrip("/")
MONAI_LABEL_TIMEOUT_SECONDS = float(os.getenv("MONAI_LABEL_TIMEOUT_SECONDS", "1800"))
ORTHANC_DICOMWEB_URL = os.getenv(
    "ORTHANC_DICOMWEB_URL",
    "http://orthanc:8042/dicom-web",
).rstrip("/")
DEFAULT_CASE_CONDITION = os.getenv("DEFAULT_CASE_CONDITION", "C2")
DATABASE_CONNECT_RETRY_SECONDS = float(os.getenv("DATABASE_CONNECT_RETRY_SECONDS", "60"))
DATABASE_CONNECT_RETRY_INTERVAL_SECONDS = float(
    os.getenv("DATABASE_CONNECT_RETRY_INTERVAL_SECONDS", "2")
)
# URL that the browser can use to retrieve generated NIfTI masks/maps.
# By default the uncertainty service proxies MONAI Label files through itself,
# avoiding Docker-only hostnames such as http://monai-label:8000 in OHIF.
PUBLIC_UNCERTAINTY_SERVICE_URL = os.getenv(
    "PUBLIC_UNCERTAINTY_SERVICE_URL",
    "http://localhost:58050",
).rstrip("/")
PUBLIC_OHIF_URL = os.getenv("PUBLIC_OHIF_URL", "http://localhost:3000").rstrip("/")
PUBLIC_MONAI_LABEL_URL = os.getenv("PUBLIC_MONAI_LABEL_URL", "").rstrip("/")
OUTPUT_DIR = Path(os.getenv("UNCERTAINTY_OUTPUT_DIR", "/tmp/uncertainty-service/outputs"))
EVALUATION_CASES_PATH = Path(
    os.getenv("EVALUATION_CASES_PATH", "/evaluation/cases.json")
)
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
]

logger = logging.getLogger(__name__)

Condition = Literal["C0", "C1", "C2", "C3", "C4", "C5"]
Policy = Literal["fifo", "high_first", "low_first", "default"]
SubmissionStatus = Literal["accepted", "edited", "rejected", "escalated", "in_review"]

# Must match EventType in ohif-viewer/extensions/extension-uncertainty/src/types.ts
# exactly. Nine of these are currently emitted by the running client; the rest are
# declared client-side but not yet wired to an emission point.
EventType = Literal[
    "case_open",
    "case_close",
    "slice_change",
    "viewport_change",
    "heatmap_toggle",
    "opacity_change",
    "accept",
    "reject",
    "edit_start",
    "edit_end",
    "snapshot",
    "submit",
    "escalate",
    "structure_focus",
]


class CaseIn(BaseModel):
    case_id: str
    patient_id: str | None = None
    study_uid: str
    series_uid: str
    condition: Condition | None = None


class EventIn(BaseModel):
    case_id: str
    reviewer_id: str
    condition: Condition
    event_type: EventType
    payload: dict[str, Any] | None = None
    client_ts: datetime | None = None


class EventsIn(BaseModel):
    events: list[EventIn]


class InferRequest(BaseModel):
    condition: Condition | None = None
    force: bool = False


class StatusUpdate(BaseModel):
    condition: Condition
    status: SubmissionStatus


app = FastAPI(title="Uncertainty Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    return RedirectResponse(PUBLIC_OHIF_URL)


@app.get("/uncertainty-review", include_in_schema=False)
async def uncertainty_review_redirect(request: Request) -> RedirectResponse:
    query = request.url.query
    suffix = f"?{query}" if query else ""
    return RedirectResponse(f"{PUBLIC_OHIF_URL}/uncertainty-review{suffix}")


@app.get("/infer/", include_in_schema=False)
async def infer_index() -> JSONResponse:
    return JSONResponse(
        status_code=405,
        content={
            "detail": "Use POST /infer/{case_id} with a case id in the path.",
            "example": (
                "POST /infer/"
                "1.2.826.0.1.3680043.8.274.1.1.521426503.86857.9032450883.677"
            ),
            "viewer": f"{PUBLIC_OHIF_URL}/uncertainty-review",
        },
    )


async def get_pool() -> asyncpg.Pool:
    pool = getattr(app.state, "pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail="database pool is not ready")
    return pool


def public_monai_label_url(label_name: str, task: str) -> str:
    """Return a browser-reachable URL for a MONAI Label datastore label.

    MONAI_LABEL_URL is often a Docker-internal address, which works from the
    FastAPI container but not from OHIF in the browser.  Unless an explicit
    PUBLIC_MONAI_LABEL_URL is supplied, expose files through this service's
    /monai proxy.
    """
    query = urlencode({"task": task})
    if PUBLIC_MONAI_LABEL_URL:
        return (
            f"{PUBLIC_MONAI_LABEL_URL}/datastore/label/"
            f"{quote(label_name, safe='')}?{query}"
        )
    return (
        f"{PUBLIC_UNCERTAINTY_SERVICE_URL}/monai/datastore/label/"
        f"{quote(label_name, safe='')}?{query}"
    )


def safe_file_case_id(case_id: str) -> str:
    return quote(case_id, safe="")


def output_path(case_id: str, filename: str) -> Path:
    return OUTPUT_DIR / safe_file_case_id(case_id) / filename


def case_root(case_id: str) -> Path:
    return OUTPUT_DIR / safe_file_case_id(case_id)


def current_generation_path(
    case_id: str,
    condition: Condition,
) -> Path | None:
    if condition not in ("C1", "C2"):
        return None
    return current_generation_dir(case_root(case_id), condition)


def cached_generation_result(
    case_id: str,
    condition: Condition,
) -> dict[str, Any] | None:
    generation = current_generation_path(case_id, condition)
    if generation is None:
        return None
    manifest = load_manifest(generation / "result.json")
    return manifest_to_inference_response(
        manifest,
        PUBLIC_UNCERTAINTY_SERVICE_URL,
        cache_hit=True,
    )


def public_output_url(case_id: str, filename: str) -> str:
    """Return a browser URL for a generated output with a cache-busting token.

    The files intentionally keep stable names (segmentation.nii.gz and
    uncertainty.nii.gz) because the workflow, tests, and manual
    debugging all refer to those names. The query string changes whenever the
    file is regenerated, so OHIF does not silently reuse a stale C1/C2 NIfTI
    from the browser cache.
    """
    path = output_path(case_id, filename)
    version = ""
    try:
        st = path.stat()
        version = f"?v={st.st_mtime_ns}-{st.st_size}"
    except OSError:
        version = ""
    return (
        f"{PUBLIC_UNCERTAINTY_SERVICE_URL}/files/"
        f"{safe_file_case_id(case_id)}/{quote(filename, safe='')}"
        f"{version}"
    )


async def run_monai_segmentation(
    client: httpx.AsyncClient,
    case: Any,
    task: str,
    *,
    require_uncertainty: bool = False,
) -> tuple[str, str | None]:
    """Run MONAI Label and persist the returned NIfTI outputs locally.

    MONAI Label's DICOM datastore expects the DICOM series UID as its image
    identifier. The uncertainty workflow keeps a stable reviewer-facing
    case_id, so this boundary translates case_id -> series_uid before calling
    MONAI and then stores the binary inference result under case_id again.  MC
    Dropout returns a zip containing both segmentation and entropy sidecar
    files; storing those under this service gives OHIF stable browser URLs.
    """
    case_id = case["case_id"]
    image_id = case["series_uid"]
    response = await client.post(
        f"{MONAI_LABEL_URL}/infer/{task}",
        params={"image": image_id, "output": "image"},
    )
    response.raise_for_status()

    return persist_monai_inference_response(
        case_id,
        response.content,
        require_uncertainty=require_uncertainty,
    )


def persist_monai_inference_response(
    case_id: str,
    content: bytes,
    *,
    require_uncertainty: bool = False,
) -> tuple[str, str | None]:
    case_dir = output_path(case_id, "segmentation.nii.gz").parent
    case_dir.mkdir(parents=True, exist_ok=True)

    segmentation_bytes, entropy_bytes = extract_monai_nifti_outputs(content)
    validate_nifti_bytes(segmentation_bytes, "segmentation")
    if entropy_bytes is not None:
        validate_nifti_bytes(entropy_bytes, "uncertainty")
    elif require_uncertainty:
        raise HTTPException(
            status_code=502,
            detail=(
                "MONAI Label MC Dropout response did not contain an entropy/"
                "uncertainty NIfTI. C2 requires uncertainty.nii.gz."
            ),
        )

    segmentation_path = output_path(case_id, "segmentation.nii.gz")
    files = {segmentation_path: segmentation_bytes}
    if entropy_bytes is not None:
        files[output_path(case_id, "uncertainty.nii.gz")] = entropy_bytes
    publish_artifacts_atomically(files)

    uncertainty_url: str | None = None
    if entropy_bytes is not None:
        uncertainty_url = public_output_url(case_id, "uncertainty.nii.gz")
    else:
        reconcile_artifact_files(case_id, "C1")

    return public_output_url(case_id, "segmentation.nii.gz"), uncertainty_url


def validate_nifti_bytes(content: bytes, label: str) -> None:
    try:
        raw = gzip.decompress(content) if content[:2] == b"\x1f\x8b" else content
    except (OSError, EOFError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"MONAI Label returned an invalid {label} NIfTI gzip payload.",
        ) from exc

    if len(raw) < 348:
        raise HTTPException(
            status_code=502,
            detail=f"MONAI Label returned a truncated {label} NIfTI payload.",
        )
    little = struct.unpack_from("<i", raw, 0)[0]
    big = struct.unpack_from(">i", raw, 0)[0]
    if 348 not in (little, big) or raw[344:348] not in (b"n+1\0", b"ni1\0"):
        raise HTTPException(
            status_code=502,
            detail=f"MONAI Label returned an invalid {label} NIfTI-1 payload.",
        )


def _write_temp_artifact(path: Path, content: bytes) -> Path:
    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temp_path.open("wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    return temp_path


def publish_artifacts_atomically(files: dict[Path, bytes]) -> None:
    temp_paths: dict[Path, Path] = {}
    backup_paths: dict[Path, Path] = {}
    published: list[Path] = []
    try:
        for path, content in files.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            temp_paths[path] = _write_temp_artifact(path, content)

        for path in files:
            if path.exists():
                backup = path.with_name(f".{path.name}.{uuid.uuid4().hex}.bak")
                os.replace(path, backup)
                backup_paths[path] = backup

        for path, temp_path in temp_paths.items():
            os.replace(temp_path, path)
            published.append(path)
    except OSError:
        for path in published:
            path.unlink(missing_ok=True)
        for path, backup in backup_paths.items():
            if backup.exists():
                os.replace(backup, path)
        raise
    finally:
        for temp_path in temp_paths.values():
            temp_path.unlink(missing_ok=True)
        for backup in backup_paths.values():
            backup.unlink(missing_ok=True)


def reconcile_artifact_files(case_id: str, condition: Condition) -> None:
    segmentation = output_path(case_id, "segmentation.nii.gz")
    uncertainty = output_path(case_id, "uncertainty.nii.gz")
    if condition == "C0":
        segmentation.unlink(missing_ok=True)
        uncertainty.unlink(missing_ok=True)
    elif condition == "C1":
        uncertainty.unlink(missing_ok=True)


def cached_inference_result(
    case_id: str,
    condition: Condition,
) -> dict[str, Any] | None:
    try:
        return cached_generation_result(case_id, condition)
    except ManifestValidationError:
        return None


def cached_legacy_inference_result(
    case_id: str,
    condition: Condition,
) -> dict[str, Any] | None:
    if condition not in ("C1", "C2"):
        return None

    segmentation_path = output_path(case_id, "segmentation.nii.gz")
    uncertainty_path = output_path(case_id, "uncertainty.nii.gz")
    if not segmentation_path.exists():
        return None
    if condition == "C2" and not uncertainty_path.exists():
        return None

    try:
        validate_nifti_bytes(segmentation_path.read_bytes(), "segmentation")
        if condition == "C2":
            validate_nifti_bytes(uncertainty_path.read_bytes(), "uncertainty")
    except (OSError, HTTPException):
        return None

    score = 0.0
    score_p95 = 0.0
    score_fraction_above = 0.0
    score_mean_all = 0.0
    threshold = 0.5
    band = None
    inference_status = None
    uncertainty_url: str | None = None
    if condition == "C2":
        uncertainty_url = public_output_url(case_id, "uncertainty.nii.gz")
        stats = compute_uncertainty_scores(
            segmentation_path,
            uncertainty_path,
            threshold=threshold,
        )
        score = float(stats["score"])
        score_p95 = float(stats["score_p95"])
        score_fraction_above = float(stats["score_fraction_above"])
        score_mean_all = float(stats["score_mean_all"])
        band = str(stats["band"])
        inference_status = str(stats.get("inference_status", "completed"))

    # Map evaluation condition to MONAI Label inference task.
    #   C1, C4 → "segmentation" (standard deterministic pass, no uncertainty output)
    #   C2, C5 → "mcdropout_seg" (MC Dropout, produces entropy sidecar)
    #   C3     → "saliency_placebo" (Sobel edge-magnitude instead of entropy)
    task = {
        "C1": "segmentation",
        "C4": "segmentation",
        "C2": "mcdropout_seg",
        "C5": "mcdropout_seg",
        "C3": "saliency_placebo",
    }.get(condition, "segmentation")
    return {
        "case_id": case_id,
        "task": task,
        "monai_label_reachable": False,
        "segmentation_url": public_output_url(case_id, "segmentation.nii.gz"),
        "uncertainty_url": uncertainty_url,
        "model_version": task,
        "num_samples": 16 if condition in ("C2", "C3", "C5") else 1,
        "score": score,
        "score_p95": score_p95,
        "score_fraction_above": score_fraction_above,
        "score_mean_all": score_mean_all,
        "threshold": threshold,
        "band": band,
        "inference_status": inference_status,
        "cache_hit": True,
    }


async def set_case_condition(
    pool: asyncpg.Pool,
    case_id: str,
    condition: Condition,
) -> None:
    await pool.execute(
        "UPDATE cases SET condition = $2 WHERE case_id = $1",
        case_id,
        condition,
    )


async def reconcile_artifact_records(pool: asyncpg.Pool) -> dict[str, int]:
    rows = await pool.fetch(
        """
        SELECT c.case_id, s.condition, s.segmentation_url, s.uncertainty_url
        FROM cases c
        LEFT JOIN uncertainty_scores s ON s.case_id = c.case_id
        """
    )
    cleared = 0
    for row in rows:
        case_id = row["case_id"]
        condition = row["condition"]
        if condition not in ("C1", "C2"):
            continue
        try:
            cached = cached_generation_result(case_id, condition)
        except ManifestValidationError:
            cached = None
        if cached is None:
            await pool.execute(
                "DELETE FROM uncertainty_scores WHERE case_id = $1 AND condition = $2",
                case_id,
                condition,
            )
            if row["segmentation_url"] or row["uncertainty_url"]:
                cleared += 1
            continue
        await pool.execute(
            """
            UPDATE uncertainty_scores
            SET score = $3, band = $4, inference_status = $5,
                uncertainty_url = $6, segmentation_url = $7, updated_at = NOW()
            WHERE case_id = $1 AND condition = $2
            """,
            case_id, condition, cached["score"], cached["band"],
            cached.get("inference_status", "completed"),
            cached["uncertainty_url"], cached["segmentation_url"],
        )

    return {"checked": len(rows), "cleared": cleared}


def extract_monai_nifti_outputs(content: bytes) -> tuple[bytes, bytes | None]:
    """Return (segmentation, entropy) bytes from MONAI Label's response."""
    buffer = io.BytesIO(content)
    if not zipfile.is_zipfile(buffer):
        return content, None

    buffer.seek(0)
    with zipfile.ZipFile(buffer) as archive:
        names = [name for name in archive.namelist() if name.lower().endswith((".nii", ".nii.gz"))]
        entropy_name = next((name for name in names if "_entropy" in Path(name).name.lower()), None)
        segmentation_name = next(
            (name for name in names if name != entropy_name and "_entropy" not in Path(name).name.lower()),
            None,
        )
        if segmentation_name is None:
            raise HTTPException(
                status_code=502,
                detail="MONAI Label inference response did not contain a segmentation NIfTI.",
            )
        segmentation_bytes = archive.read(segmentation_name)
        entropy_bytes = archive.read(entropy_name) if entropy_name else None
        return segmentation_bytes, entropy_bytes


async def init_schema(pool: asyncpg.Pool) -> None:
    await pool.execute(
        """
        CREATE TABLE IF NOT EXISTS cases (
          case_id TEXT PRIMARY KEY,
          patient_id TEXT,
          study_uid TEXT NOT NULL,
          series_uid TEXT NOT NULL,
          condition TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS uncertainty_scores (
          case_id TEXT REFERENCES cases(case_id) ON DELETE CASCADE,
          condition TEXT NOT NULL DEFAULT 'C2',
          score DOUBLE PRECISION,
          band TEXT,
          inference_status TEXT DEFAULT 'completed',
          uncertainty_url TEXT,
          segmentation_url TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- Migration for existing databases: add inference_status if missing
        ALTER TABLE uncertainty_scores
        ADD COLUMN IF NOT EXISTS inference_status TEXT DEFAULT 'completed';
        ALTER TABLE uncertainty_scores ADD COLUMN IF NOT EXISTS condition TEXT;
        UPDATE uncertainty_scores s
        SET condition = COALESCE(s.condition, c.condition, 'C2')
        FROM cases c
        WHERE c.case_id = s.case_id AND s.condition IS NULL;
        ALTER TABLE uncertainty_scores ALTER COLUMN condition SET NOT NULL;
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'uncertainty_scores'::regclass AND contype = 'p'
              AND pg_get_constraintdef(oid) NOT LIKE '%condition%'
          ) THEN
            ALTER TABLE uncertainty_scores DROP CONSTRAINT uncertainty_scores_pkey;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'uncertainty_scores'::regclass AND contype = 'p'
          ) THEN
            ALTER TABLE uncertainty_scores
              ADD CONSTRAINT uncertainty_scores_pkey PRIMARY KEY (case_id, condition);
          END IF;
        END $$;

        CREATE TABLE IF NOT EXISTS annotation_status (
          case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          reviewer_id TEXT NOT NULL,
          condition TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TIMESTAMPTZ,
          ended_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (case_id, reviewer_id, condition)
        );

        CREATE TABLE IF NOT EXISTS review_events (
          id BIGSERIAL PRIMARY KEY,
          case_id TEXT NOT NULL,
          reviewer_id TEXT NOT NULL,
          condition TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload JSONB,
          client_ts TIMESTAMPTZ,
          server_ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS uncertainty_annotations (
          id BIGSERIAL PRIMARY KEY,
          case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          reviewer_id TEXT NOT NULL,
          condition TEXT NOT NULL,
          status TEXT NOT NULL,
          storage_url TEXT,
          mask_filename TEXT,
          mask_content_type TEXT,
          mask_size_bytes INTEGER,
          edit_voxel_count INTEGER,
          ai_foreground_voxels INTEGER,
          reviewer_foreground_voxels INTEGER,
          edit_fraction_of_ai_foreground DOUBLE PRECISION,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS inference_results (
          id BIGSERIAL PRIMARY KEY,
          case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
          generation_id UUID NOT NULL,
          condition TEXT NOT NULL,
          provenance_category TEXT NOT NULL,
          checkpoint_sha256 TEXT NOT NULL,
          result JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (case_id, generation_id)
        );

        CREATE INDEX IF NOT EXISTS idx_review_events_case
          ON review_events(case_id, reviewer_id);
        CREATE INDEX IF NOT EXISTS idx_uncertainty_scores_score
          ON uncertainty_scores(condition, score);
        CREATE INDEX IF NOT EXISTS idx_inference_results_case_created
          ON inference_results(case_id, created_at DESC);
        """
    )
    await pool.execute(
        """
        ALTER TABLE annotation_status
          ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'annotation_status'::regclass AND contype = 'p'
              AND pg_get_constraintdef(oid) NOT LIKE '%condition%'
          ) THEN
            ALTER TABLE annotation_status DROP CONSTRAINT annotation_status_pkey;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'annotation_status'::regclass AND contype = 'p'
          ) THEN
            ALTER TABLE annotation_status
              ADD CONSTRAINT annotation_status_pkey
              PRIMARY KEY (case_id, reviewer_id, condition);
          END IF;
        END $$;

        ALTER TABLE uncertainty_annotations
          ADD COLUMN IF NOT EXISTS storage_url TEXT,
          ADD COLUMN IF NOT EXISTS ai_foreground_voxels INTEGER,
          ADD COLUMN IF NOT EXISTS reviewer_foreground_voxels INTEGER;
        """
    )


async def fetch_orthanc_cases(
    client: httpx.AsyncClient,
    *,
    orthanc_url: str = ORTHANC_DICOMWEB_URL,
    default_condition: str = DEFAULT_CASE_CONDITION,
) -> tuple[list[Any], list[str]]:
    studies_response = await client.get(f"{orthanc_url}/studies")
    studies_response.raise_for_status()
    studies = studies_response.json()

    series_by_study: dict[str, list[dict[str, Any]]] = {}
    for study in studies:
        values = study.get("0020000D", {}).get("Value", [])
        if not values:
            continue
        study_uid = str(values[0])
        series_response = await client.get(
            f"{orthanc_url}/studies/{quote(study_uid, safe='')}/series"
        )
        series_response.raise_for_status()
        series_by_study[study_uid] = series_response.json()

    return discover_cases(
        studies,
        series_by_study,
        default_condition=default_condition,
    )


async def sync_cases_from_orthanc(
    pool: asyncpg.Pool,
    client: httpx.AsyncClient,
    *,
    orthanc_url: str = ORTHANC_DICOMWEB_URL,
    default_condition: str = DEFAULT_CASE_CONDITION,
) -> dict[str, int]:
    cases, skipped = await fetch_orthanc_cases(
        client,
        orthanc_url=orthanc_url,
        default_condition=default_condition,
    )
    existing_rows = await pool.fetch("SELECT case_id FROM cases")
    existing_ids = {row["case_id"] for row in existing_rows}

    inserted = 0
    updated = 0
    for case in cases:
        await pool.execute(
            """
            INSERT INTO cases (case_id, patient_id, study_uid, series_uid, condition)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (case_id) DO UPDATE
            SET patient_id = EXCLUDED.patient_id,
                study_uid = EXCLUDED.study_uid,
                series_uid = EXCLUDED.series_uid,
                condition = COALESCE(cases.condition, EXCLUDED.condition)
            """,
            case.case_id,
            case.patient_id,
            case.study_uid,
            case.series_uid,
            case.condition,
        )
        if case.case_id in existing_ids:
            updated += 1
        else:
            inserted += 1
            existing_ids.add(case.case_id)

    skipped_ids = skipped  # from fetch_orthanc_cases
    logger.info(
        "Orthanc sync complete: %d discovered, %d inserted, %d updated, %d skipped",
        len(cases),
        inserted,
        updated,
        len(skipped_ids),
    )

    return {
        "discovered": len(cases),
        "inserted": inserted,
        "updated": updated,
        "skipped": len(skipped),
    }


async def best_effort_sync_cases(
    pool: asyncpg.Pool,
    *,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    try:
        if client is not None:
            return await sync_cases_from_orthanc(pool, client)
        async with httpx.AsyncClient(timeout=30) as owned_client:
            return await sync_cases_from_orthanc(pool, owned_client)
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        logger.warning("Orthanc case synchronization failed: %s", exc)
        return {
            "discovered": 0,
            "inserted": 0,
            "updated": 0,
            "skipped": 0,
            "error": str(exc),
        }


async def create_database_pool_with_retry() -> asyncpg.Pool:
    """Create the asyncpg pool, tolerating Docker DNS/database startup races."""
    deadline = (
        asyncio.get_running_loop().time()
        + max(0.0, DATABASE_CONNECT_RETRY_SECONDS)
    )
    attempt = 0
    while True:
        attempt += 1
        try:
            return await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
        except (OSError, asyncpg.PostgresError) as exc:
            now = asyncio.get_running_loop().time()
            if now >= deadline:
                logger.error(
                    "Database pool creation failed after %d attempt(s): %s",
                    attempt,
                    exc,
                )
                raise
            wait_seconds = min(
                max(0.0, DATABASE_CONNECT_RETRY_INTERVAL_SECONDS),
                max(0.0, deadline - now),
            )
            logger.warning(
                "Database pool creation failed on attempt %d; retrying in %.1fs: %s",
                attempt,
                wait_seconds,
                exc,
            )
            await asyncio.sleep(wait_seconds)


@app.on_event("startup")
async def startup() -> None:
    app.state.pool = await create_database_pool_with_retry()
    await init_schema(app.state.pool)
    await best_effort_sync_cases(app.state.pool)
    await reconcile_artifact_records(app.state.pool)


@app.on_event("shutdown")
async def shutdown() -> None:
    pool = getattr(app.state, "pool", None)
    if pool is not None:
        await pool.close()


@app.get("/health")
async def health() -> dict[str, Any]:
    pool = await get_pool()
    await pool.fetchval("SELECT 1")
    return {
        "status": "healthy",
        "database": "healthy",
        "monai_label_url": MONAI_LABEL_URL,
        "public_uncertainty_service_url": PUBLIC_UNCERTAINTY_SERVICE_URL,
        "public_monai_label_url": PUBLIC_MONAI_LABEL_URL or None,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def msd_experiment_ready(
    configuration_error: str | None,
    msd_status: list[dict[str, Any]],
) -> bool:
    """True when the five fixed MSD cases all have valid C2 generations.

    Extra configured cases (e.g. DET detection cases, which have no msd_case
    and no C2 generation) must not block readiness of the checkpoint
    experiment.
    """
    return (
        configuration_error is None
        and len(msd_status) == 5
        and all(row["c2_generation_valid"] for row in msd_status)
    )


async def monai_label_ready(client: httpx.AsyncClient | None = None) -> tuple[bool, str | None]:
    """Probe the inference dependency used by both C1 and C2 workflows."""
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=5.0)
    try:
        response = await client.get(f"{MONAI_LABEL_URL}/info/")
        response.raise_for_status()
        return True, None
    except (httpx.HTTPError, OSError) as exc:
        return False, str(exc)
    finally:
        if owns_client:
            await client.aclose()


@app.get("/health/ready")
async def readiness() -> Response:
    pool = await get_pool()
    await pool.fetchval("SELECT 1")
    configured: list[dict[str, Any]] = []
    configuration_error: str | None = None
    try:
        loaded = json.loads(EVALUATION_CASES_PATH.read_text(encoding="utf-8"))
        if not isinstance(loaded, list):
            raise ValueError("evaluation cases must be a JSON array")
        configured = [dict(case) for case in loaded]
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        configuration_error = str(exc)

    case_status: list[dict[str, Any]] = []
    for case in configured:
        case_id = str(case.get("case_id") or case.get("study_uid") or "")
        valid = False
        error: str | None = None
        if not case_id:
            error = "case has no case_id or study_uid"
        else:
            try:
                valid = current_generation_path(case_id, "C2") is not None
            except ManifestValidationError as exc:
                error = str(exc)
        case_status.append(
            {
                "case_id": case_id,
                "patient_id": case.get("patient_id"),
                "msd_case": case.get("msd_case"),
                "c2_generation_valid": valid,
                "error": error,
            }
        )

    # The experiment is defined by the five fixed MSD cases (patient001-005);
    # extra configured cases (e.g. DET detection cases) are not part of the
    # checkpoint-experiment readiness gate.
    msd_status = [row for row in case_status if row["msd_case"]]
    experiment_ready = msd_experiment_ready(
        configuration_error,
        msd_status,
    )
    monai_ready, monai_error = await monai_label_ready()
    ready = experiment_ready and monai_ready
    payload = {
        "status": "healthy" if ready else "unhealthy",
        "ready": ready,
        "database": "healthy",
        "monai_label": "healthy" if monai_ready else "unhealthy",
        "monai_label_error": monai_error,
        "output_directory": str(OUTPUT_DIR),
        "evaluation_cases_path": str(EVALUATION_CASES_PATH),
        "configuration_error": configuration_error,
        "cases": case_status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    return JSONResponse(payload, status_code=200 if ready else 503)


@app.api_route("/monai/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def monai_proxy(path: str, request: Request) -> Response:
    """Browser-facing proxy for MONAI Label datastore files.

    The frontend must never receive Docker-only URLs like
    http://monai-label:8000/..., because the browser cannot resolve them.
    This endpoint relays the request from OHIF to MONAI Label using
    MONAI_LABEL_URL, which *is* allowed to be Docker-internal.
    """
    target = f"{MONAI_LABEL_URL}/{path}"
    headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in {"host", "content-length", "connection"}
    }
    body = await request.body()
    try:
        async with httpx.AsyncClient(timeout=MONAI_LABEL_TIMEOUT_SECONDS) as client:
            upstream = await client.request(
                request.method,
                target,
                params=request.query_params,
                content=body,
                headers=headers,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"MONAI Label proxy failed for /{path}: {exc}",
        ) from exc

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )


@app.get("/files/{case_token}/{filename}")
async def output_file(case_token: str, filename: str) -> FileResponse:
    path = OUTPUT_DIR / case_token / filename
    resolved = path.resolve()
    root = OUTPUT_DIR.resolve()
    if root not in resolved.parents:
        raise HTTPException(status_code=400, detail="invalid output path")
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="output file not found")
    return FileResponse(
        resolved,
        media_type="application/gzip",
        filename=filename,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/files/{case_token}/{condition}/{filename}")
async def generation_output_file(
    case_token: str,
    condition: Condition,
    filename: str,
) -> FileResponse:
    if condition not in ("C1", "C2"):
        raise HTTPException(status_code=404, detail="AI artifact not available")
    generation = current_generation_dir(
        OUTPUT_DIR / case_token,
        condition,
    )
    if generation is None:
        raise HTTPException(status_code=404, detail="output generation not found")
    manifest = load_manifest(generation / "result.json")
    artifact = next(
        (
            metadata
            for metadata in manifest["artifacts"].values()
            if metadata["filename"] == filename
        ),
        None,
    )
    if artifact is None:
        raise HTTPException(status_code=404, detail="output file not found")
    resolved = (generation / filename).resolve()
    if generation.resolve() not in resolved.parents:
        raise HTTPException(status_code=400, detail="invalid output path")
    return FileResponse(
        resolved,
        media_type=artifact["media_type"],
        filename=filename,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/annotation-files/{case_token}/{reviewer_token}/{condition}/{filename}")
async def annotation_file(
    case_token: str,
    reviewer_token: str,
    condition: Condition,
    filename: str,
) -> FileResponse:
    root = OUTPUT_DIR.resolve()
    path = (
        OUTPUT_DIR / case_token / "annotations" / reviewer_token / condition / filename
    ).resolve()
    if root not in path.parents:
        raise HTTPException(status_code=400, detail="invalid annotation path")
    if not path.exists():
        raise HTTPException(status_code=404, detail="annotation file not found")
    return FileResponse(
        path,
        media_type="application/gzip",
        filename=filename,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@app.get("/results/{case_id}")
async def result_manifest(
    case_id: str,
    condition: Condition = Query("C2"),
) -> JSONResponse:
    if condition not in ("C1", "C2"):
        raise HTTPException(status_code=404, detail="result not available")
    generation = current_generation_path(case_id, condition)
    if generation is None:
        raise HTTPException(status_code=404, detail="result generation not found")
    return JSONResponse(load_manifest(generation / "result.json"))


@app.get("/cases")
async def list_cases(condition: Condition = Query("C2")) -> list[dict[str, Any]]:
    pool = await get_pool()
    await best_effort_sync_cases(pool)
    await reconcile_artifact_records(pool)
    rows = await pool.fetch(
        """
        SELECT c.case_id, c.patient_id, c.study_uid, c.series_uid, $1::text AS condition,
               s.score, s.band, s.inference_status, s.uncertainty_url, s.segmentation_url
        FROM cases c
        LEFT JOIN uncertainty_scores s
          ON s.case_id = c.case_id AND s.condition = $1
        ORDER BY c.created_at DESC
        """,
        condition,
    )
    return [dict(row) for row in rows]


@app.post("/cases/sync")
async def sync_cases() -> dict[str, int]:
    pool = await get_pool()
    async with httpx.AsyncClient(timeout=30) as client:
        return await sync_cases_from_orthanc(pool, client)


@app.post("/cases", status_code=201)
async def upsert_case(case: CaseIn) -> dict[str, Any]:
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        INSERT INTO cases (case_id, patient_id, study_uid, series_uid, condition)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (case_id) DO UPDATE
        SET patient_id = EXCLUDED.patient_id,
            study_uid = EXCLUDED.study_uid,
            series_uid = EXCLUDED.series_uid,
            condition = EXCLUDED.condition
        RETURNING case_id, patient_id, study_uid, series_uid, condition
        """,
        case.case_id,
        case.patient_id,
        case.study_uid,
        case.series_uid,
        case.condition,
    )
    if case.condition is not None:
        await set_case_condition(pool, case.case_id, case.condition)
    return dict(row)


@app.get("/worklist")
async def worklist(
    policy: Policy = "fifo",
    limit: int = Query(50, ge=1, le=500),
    reviewer_id: str | None = None,
    condition: Condition = Query("C2"),
) -> list[dict[str, Any]]:
    _ALLOWED_ORDERS = frozenset({
        "fifo",
        "high_first",
        "low_first",
        "default",
    })
    if policy not in _ALLOWED_ORDERS:
        raise ValueError(f"Unknown worklist policy: {policy!r}")
    order_sql = {
        "fifo": "c.created_at ASC",
        "high_first": "s.score DESC NULLS LAST, c.created_at ASC",
        "low_first": "s.score ASC NULLS LAST, c.created_at ASC",
        "default": "RANDOM()",
    }[policy]
    pool = await get_pool()
    await best_effort_sync_cases(pool)
    await reconcile_artifact_records(pool)
    rows = await pool.fetch(
        f"""
        SELECT c.case_id, c.patient_id, c.study_uid, c.series_uid,
               s.score, s.band AS score_band, s.inference_status,
               COALESCE(st.status, 'ready') AS status
        FROM cases c
        LEFT JOIN uncertainty_scores s
          ON s.case_id = c.case_id AND s.condition = $3
        LEFT JOIN annotation_status st
          ON st.case_id = c.case_id
         AND st.condition = $3
         AND ($1::text IS NULL OR st.reviewer_id = $1)
        ORDER BY {order_sql}
        LIMIT $2
        """,
        reviewer_id,
        limit,
        condition,
    )
    return [dict(row) for row in rows]


@app.post("/infer/{case_id}")
async def infer(case_id: str, request: InferRequest | None = None) -> dict[str, Any]:
    pool = await get_pool()
    case = await pool.fetchrow("SELECT * FROM cases WHERE case_id = $1", case_id)
    if case is None:
        await best_effort_sync_cases(pool)
        case = await pool.fetchrow("SELECT * FROM cases WHERE case_id = $1", case_id)
        if case is None:
            # Check if the study exists in Orthanc with a non-CT modality
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    series_resp = await client.get(
                        f"{ORTHANC_DICOMWEB_URL}/studies/{quote(case_id, safe='')}/series"
                    )
                    series_resp.raise_for_status()
                    series_data = series_resp.json()
                    if series_data:
                        modalities = sorted(
                            {
                                str(s.get("00080060", {}).get("Value", ["?"])[0])
                                for s in series_data
                            }
                        )
                        raise HTTPException(
                            status_code=404,
                            detail=(
                                f"Case {case_id} exists in Orthanc but has no CT series "
                                f"(modalities: {', '.join(modalities)}) — "
                                f"inference requires CT modality"
                            ),
                        )
            except httpx.HTTPError:
                pass
            raise HTTPException(status_code=404, detail=f"Unknown case: {case_id}")

    condition = request.condition if request else case["condition"]
    if condition is None:
        condition = DEFAULT_CASE_CONDITION
    if request and request.force:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "administrative_generation_only",
                "message": (
                    "Model generation is not available through the public "
                    "browser inference route."
                ),
            },
        )
    if condition not in ("C1", "C2"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Condition {condition!r} does not use inference. "
                "Only C1 and C2 are wired to run inference; C0 is manual "
                "review, and C3/C4/C5 are not yet connected to this endpoint."
            ),
        )
    try:
        cached = cached_generation_result(case_id, condition)
    except ManifestValidationError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "invalid_generation",
                "message": str(exc),
                "case_id": case_id,
                "condition": condition,
            },
        ) from exc
    if cached is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "generation_required",
                "message": (
                    "No validated precomputed result exists. Run the "
                    "administrative precompute command."
                ),
                "case_id": case_id,
                "condition": condition,
            },
        )

    await pool.execute(
        """
        INSERT INTO uncertainty_scores
          (case_id, condition, score, band, inference_status, uncertainty_url, segmentation_url, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (case_id, condition) DO UPDATE
        SET score = EXCLUDED.score,
            band = EXCLUDED.band,
            inference_status = EXCLUDED.inference_status,
            uncertainty_url = EXCLUDED.uncertainty_url,
            segmentation_url = EXCLUDED.segmentation_url,
            updated_at = NOW()
        """,
        case_id,
        condition,
        cached["score"],
        cached["band"],
        cached.get("inference_status", "completed"),
        cached["uncertainty_url"],
        cached["segmentation_url"],
    )
    return cached


@app.post("/events")
async def events(events_in: EventsIn) -> dict[str, int]:
    pool = await get_pool()
    event_items = events_in.events
    async with pool.acquire() as conn:
        await conn.executemany(
            """
            INSERT INTO review_events
              (case_id, reviewer_id, condition, event_type, payload, client_ts)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
            """,
            [
                (
                    ev.case_id,
                    ev.reviewer_id,
                    ev.condition,
                    ev.event_type,
                    json.dumps(ev.payload) if ev.payload is not None else None,
                    ev.client_ts,
                )
                for ev in event_items
            ],
        )
    return {"ingested": len(event_items)}


@app.put("/annotations/status/{case_id}/{reviewer_id}")
async def update_status(
    case_id: str,
    reviewer_id: str,
    update: StatusUpdate,
) -> dict[str, Any]:
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        INSERT INTO annotation_status
          (case_id, reviewer_id, condition, status, started_at, ended_at, updated_at)
        VALUES (
          $1, $2, $3, $4,
          CASE WHEN $4 = 'in_review' THEN NOW() ELSE NULL END,
          CASE WHEN $4 <> 'in_review' THEN NOW() ELSE NULL END,
          NOW()
        )
        ON CONFLICT (case_id, reviewer_id, condition) DO UPDATE
        SET status = EXCLUDED.status,
            started_at = COALESCE(annotation_status.started_at, EXCLUDED.started_at, NOW()),
            ended_at = CASE
              WHEN EXCLUDED.status = 'in_review' THEN NULL
              ELSE COALESCE(EXCLUDED.ended_at, NOW())
            END,
            updated_at = NOW()
        RETURNING case_id, reviewer_id, condition, status, started_at, ended_at
        """,
        case_id,
        reviewer_id,
        update.condition,
        update.status,
    )
    return dict(row)


@app.get("/annotations/{case_id}/{reviewer_id}")
async def get_annotation(
    case_id: str,
    reviewer_id: str,
    condition: Condition,
) -> dict[str, Any]:
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        SELECT *
        FROM uncertainty_annotations
        WHERE case_id = $1 AND reviewer_id = $2 AND condition = $3
        ORDER BY created_at DESC
        LIMIT 1
        """,
        case_id,
        reviewer_id,
        condition,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="annotation not found")
    return dict(row)


@app.post("/annotations")
async def submit_annotation(
    case_id: str = Form(...),
    reviewer_id: str = Form(...),
    condition: Condition = Form(...),
    status: SubmissionStatus = Form(...),
    mask: UploadFile | None = File(None),
) -> dict[str, Any]:
    if status != "rejected" and mask is None:
        raise HTTPException(status_code=422, detail=f"status '{status}' requires a mask upload")
    if condition == "C0" and status == "accepted":
        raise HTTPException(status_code=422, detail="C0 has no AI mask to accept")

    mask_bytes = await mask.read() if mask is not None else b""
    annotation_path: Path | None = None
    storage_url: str | None = None
    ai_foreground_voxels = 0
    reviewer_foreground_voxels = 0
    edit_voxel_count = 0
    edit_fraction = 0.0
    if mask is not None:
        try:
            validate_nifti_bytes(mask_bytes, "reviewer annotation")
        except HTTPException as exc:
            raise HTTPException(status_code=422, detail=exc.detail) from exc
        filename = f"{uuid.uuid4()}.nii.gz"
        case_token = safe_file_case_id(case_id)
        reviewer_token = quote(reviewer_id, safe="")
        annotation_path = (
            OUTPUT_DIR / case_token / "annotations" / reviewer_token / condition / filename
        )
        annotation_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = _write_temp_artifact(annotation_path, mask_bytes)
        os.replace(temp_path, annotation_path)
        storage_url = (
            f"{PUBLIC_UNCERTAINTY_SERVICE_URL}/annotation-files/"
            f"{case_token}/{reviewer_token}/{condition}/{filename}"
        )
        try:
            reviewer_foreground_voxels = int((load_nifti(annotation_path) > 0).sum())
            edit_voxel_count = reviewer_foreground_voxels
            if condition in ("C1", "C2"):
                generation = current_generation_path(case_id, condition)
                if generation is None:
                    raise HTTPException(
                        status_code=409,
                        detail=f"no validated {condition} AI segmentation exists for diff scoring",
                    )
                diff = diff_files(annotation_path, generation / "segmentation.nii.gz")
                edit_voxel_count = diff.edit_voxel_count
                ai_foreground_voxels = diff.ai_foreground_voxels
                reviewer_foreground_voxels = diff.reviewer_foreground_voxels
                edit_fraction = diff.edit_fraction_of_ai_foreground
        except Exception:
            annotation_path.unlink(missing_ok=True)
            raise
    pool = await get_pool()
    try:
        row = await pool.fetchrow(
            """
            INSERT INTO uncertainty_annotations
              (case_id, reviewer_id, condition, status, storage_url, mask_filename,
               mask_content_type, mask_size_bytes, edit_voxel_count,
               ai_foreground_voxels, reviewer_foreground_voxels,
               edit_fraction_of_ai_foreground)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING case_id, reviewer_id, condition, storage_url,
                      edit_voxel_count, ai_foreground_voxels,
                      reviewer_foreground_voxels,
                      edit_fraction_of_ai_foreground,
                      created_at AS submitted_at
            """,
            case_id, reviewer_id, condition, status, storage_url,
            annotation_path.name if annotation_path is not None else None,
            mask.content_type if mask is not None else None, len(mask_bytes),
            edit_voxel_count, ai_foreground_voxels,
            reviewer_foreground_voxels, edit_fraction,
        )
    except Exception:
        if annotation_path is not None:
            annotation_path.unlink(missing_ok=True)
        raise
    await update_status(case_id, reviewer_id, StatusUpdate(condition=condition, status=status))
    return dict(row)
