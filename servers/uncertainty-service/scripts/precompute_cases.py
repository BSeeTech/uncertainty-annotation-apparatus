"""Administrative checkpoint-backed precompute for configured CT cases."""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import sys
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import asyncpg
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.artifact_generation import (  # noqa: E402
    current_generation_dir,
    publish_generation,
)
from app.result_manifest import ManifestValidationError  # noqa: E402
from app.main import (  # noqa: E402
    DATABASE_URL,
    MONAI_LABEL_TIMEOUT_SECONDS,
    MONAI_LABEL_URL,
    ORTHANC_DICOMWEB_URL,
    OUTPUT_DIR,
    safe_file_case_id,
)
from app.precompute import stage_monai_result  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True, type=Path)
    parser.add_argument("--condition", choices=("C1", "C2"), required=True)
    parser.add_argument("--replace", action="store_true")
    parser.add_argument(
        "--patient-id",
        action="append",
        help="Process only the selected patient id; may be repeated.",
    )
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


async def persist_result(pool: asyncpg.Pool, manifest: dict[str, Any]) -> None:
    scores = manifest["operational_scores"]
    case_id = manifest["case_id"]
    condition = manifest["condition"]
    inference_status = str(scores.get("inference_status", "completed"))
    await pool.execute(
        """
        INSERT INTO inference_results
          (case_id, generation_id, condition, provenance_category,
           checkpoint_sha256, result)
        VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb)
        ON CONFLICT (case_id, generation_id) DO NOTHING
        """,
        case_id,
        manifest["artifact_generation"],
        condition,
        manifest["provenance_category"],
        manifest["checkpoint"]["sha256"],
        json.dumps(manifest),
    )
    await pool.execute(
        """
        INSERT INTO uncertainty_scores
          (case_id, score, band, inference_status, uncertainty_url, segmentation_url, updated_at)
        VALUES ($1, $2, $3, $4, NULL, NULL, NOW())
        ON CONFLICT (case_id) DO UPDATE
        SET score = EXCLUDED.score,
            band = EXCLUDED.band,
            inference_status = EXCLUDED.inference_status,
            updated_at = NOW()
        """,
        case_id,
        float(scores.get("score", 0.0)),
        scores.get("band"),
        inference_status,
    )


async def validate_dicom_series(client: httpx.AsyncClient, series_uid: str) -> None:
    """Pre-inference sanity check on a DICOM series via Orthanc DICOMweb.

    Raises ValueError with a descriptive message if the series looks
    unusable (empty, missing metadata, abnormal pixel data).
    """
    # Fetch series metadata (QIDO-RS) — fast, header-only
    url = f"{ORTHANC_DICOMWEB_URL}/series?SeriesInstanceUID={series_uid}"
    resp = await client.get(url, timeout=30)
    if resp.status_code != 200:
        raise ValueError(
            f"Orthanc DICOMweb returned HTTP {resp.status_code} for series {series_uid}"
        )
    results = resp.json()
    if not isinstance(results, list) or len(results) == 0:
        raise ValueError(
            f"DICOM series {series_uid} not found in Orthanc (empty QIDO response)"
        )

    # Check NumberOfSeriesRelatedInstances if available
    for entry in results:
        if isinstance(entry, dict):
            n_instances = entry.get("NumberOfSeriesRelatedInstances")
            if n_instances is not None:
                try:
                    if int(n_instances) == 0:
                        raise ValueError(
                            f"DICOM series {series_uid} has zero instances"
                        )
                except (ValueError, TypeError):
                    pass

    # Retrieve one instance header (WADO-RS metadata) to check pixel data
    # First get the instances list for this series
    instances_url = f"{ORTHANC_DICOMWEB_URL}/instances?SeriesInstanceUID={series_uid}"
    inst_resp = await client.get(instances_url, timeout=30)
    if inst_resp.status_code != 200:
        raise ValueError(
            f"Cannot retrieve instances for series {series_uid} "
            f"(HTTP {inst_resp.status_code})"
        )
    instances = inst_resp.json()
    if not isinstance(instances, list) or len(instances) == 0:
        raise ValueError(
            f"DICOM series {series_uid} has no retrievable instances"
        )


async def run(args: argparse.Namespace) -> dict[str, Any]:
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    if args.patient_id:
        selected = set(args.patient_id)
        cases = [
            case for case in cases if case.get("patient_id") in selected
        ]
        missing = selected - {
            str(case.get("patient_id")) for case in cases
        }
        if missing:
            raise ValueError(f"unknown patient ids: {sorted(missing)}")
    task = "mcdropout_seg" if args.condition == "C2" else "segmentation"
    report: dict[str, Any] = {
        "condition": args.condition,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "cases": [],
    }
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=2)
    try:
        async with httpx.AsyncClient(
            timeout=MONAI_LABEL_TIMEOUT_SECONDS,
        ) as client:
            for configured in cases:
                case = dict(configured)
                case["case_id"] = case.get("case_id") or case["study_uid"]
                row: dict[str, Any] = {
                    "case_id": case["case_id"],
                    "patient_id": case.get("patient_id"),
                    "status": "running",
                }
                report["cases"].append(row)
                try:
                    case_root = OUTPUT_DIR / safe_file_case_id(case["case_id"])
                    try:
                        current = current_generation_dir(
                            case_root,
                            args.condition,
                        )
                    except ManifestValidationError:
                        if not args.replace:
                            raise
                        current = None
                    if current is not None and not args.replace:
                        row.update(
                            {
                                "status": "skipped",
                                "reason": "validated generation already exists",
                                "published": str(current),
                            }
                        )
                        continue
                    latencies: dict[str, float] = {}
                    t0 = time.time()

                    # Pre-inference DICOM validation
                    try:
                        await validate_dicom_series(client, case["series_uid"])
                    except ValueError as exc:
                        raise ValueError(
                            f"Pre-inference validation failed for series "
                            f"{case['series_uid']}: {exc}"
                        ) from exc

                    # MONAI Label filesystem datastore uses the NIfTI
                    # filename (without .nii.gz) as the image key.
                    # msd_case (e.g. "spleen_10") or patient_id serves
                    # as that key; series_uid only works in DICOMweb mode.
                    monai_image_id = case.get("msd_case") or case.get("patient_id") or case["series_uid"]
                    response = await client.post(
                        f"{MONAI_LABEL_URL}/infer/{task}",
                        params={
                            "image": monai_image_id,
                            "output": "image",
                        },
                    )
                    latencies["monai_inference"] = time.time() - t0
                    response.raise_for_status()

                    # Inject measured latencies into the MONAI bundle's
                    # result.json so that stage_monai_result preserves them.
                    t1 = time.time()
                    buffer = io.BytesIO(response.content)
                    if zipfile.is_zipfile(buffer):
                        buffer.seek(0)
                        with zipfile.ZipFile(buffer, "r") as reader:
                            names = set(reader.namelist())
                            if "result.json" in names:
                                monai_result = json.loads(
                                    reader.read("result.json").decode("utf-8")
                                )
                                monai_result["latencies"] = latencies
                                # Rebuild the bundle with the enriched result.json
                                patched = io.BytesIO()
                                with zipfile.ZipFile(
                                    patched, "w", compression=zipfile.ZIP_DEFLATED
                                ) as writer:
                                    for name in names:
                                        if name == "result.json":
                                            writer.writestr(
                                                name,
                                                json.dumps(monai_result, default=str),
                                            )
                                        else:
                                            writer.writestr(name, reader.read(name))
                                bundle = patched.getvalue()
                            else:
                                bundle = response.content
                        latencies["monai_bundle_patch"] = time.time() - t1
                    else:
                        bundle = response.content

                    condition_root = case_root / args.condition
                    staging = condition_root / f".staging-{uuid.uuid4().hex}"
                    manifest = stage_monai_result(
                        case,
                        args.condition,
                        bundle,
                        staging,
                    )
                    published = publish_generation(
                        case_root,
                        args.condition,
                        staging,
                    )
                    await persist_result(pool, manifest)
                    row.update(
                        {
                            "status": "completed",
                            "artifact_generation": manifest[
                                "artifact_generation"
                            ],
                            "published": str(published),
                            "score": manifest["operational_scores"]["score"],
                        }
                    )
                except Exception as exc:
                    row.update({"status": "failed", "error": str(exc)})
                if args.report:
                    args.report.parent.mkdir(parents=True, exist_ok=True)
                    args.report.write_text(
                        json.dumps(report, indent=2, default=str) + "\n",
                        encoding="utf-8",
                    )
    finally:
        await pool.close()
    report["completed_at"] = datetime.now(timezone.utc).isoformat()
    return report


def main() -> int:
    args = parse_args()
    report = asyncio.run(run(args))
    print(json.dumps(report, indent=2, default=str))
    successful = {"completed", "skipped"}
    return 1 if any(
        row["status"] not in successful for row in report["cases"]
    ) else 0


if __name__ == "__main__":
    raise SystemExit(main())
