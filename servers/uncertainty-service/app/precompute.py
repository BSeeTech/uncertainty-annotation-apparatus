"""Convert a complete MONAI bundle into a validated staging generation."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import struct
import uuid
import zipfile
from pathlib import Path
from typing import Any

from app.result_manifest import validate_manifest
from app.scoring import compute_uncertainty_scores


ARCHIVE_FILES = {
    "segmentation": "segmentation.nii.gz",
    "uncertainty": "uncertainty.nii.gz",
    "foreground_probability": "foreground_probability.nii.gz",
}


def _validate_nifti(content: bytes, label: str) -> None:
    try:
        raw = gzip.decompress(content) if content[:2] == b"\x1f\x8b" else content
    except (OSError, EOFError) as exc:
        raise ValueError(f"invalid {label} NIfTI gzip payload") from exc
    if len(raw) < 348:
        raise ValueError(f"truncated {label} NIfTI payload")
    little = struct.unpack_from("<i", raw, 0)[0]
    big = struct.unpack_from(">i", raw, 0)[0]
    if 348 not in (little, big) or raw[344:348] not in (b"n+1\0", b"ni1\0"):
        raise ValueError(f"invalid {label} NIfTI-1 payload")


def _artifact_metadata(path: Path) -> dict[str, Any]:
    return {
        "filename": path.name,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "size_bytes": path.stat().st_size,
        "media_type": "application/gzip",
    }


def _read_monai_bundle(content: bytes) -> tuple[dict[str, bytes], dict[str, Any]]:
    buffer = io.BytesIO(content)
    if not zipfile.is_zipfile(buffer):
        raise ValueError("MONAI response must be a complete zip bundle")
    buffer.seek(0)
    with zipfile.ZipFile(buffer) as archive:
        names = set(archive.namelist())
        if "result.json" not in names:
            raise ValueError("MONAI bundle is missing result.json")
        result = json.loads(archive.read("result.json").decode("utf-8"))
        files = {
            name: archive.read(filename)
            for name, filename in ARCHIVE_FILES.items()
            if filename in names
        }
    return files, result


def stage_monai_result(
    case: dict[str, Any],
    condition: str,
    bundle: bytes,
    staging_dir: Path,
) -> dict[str, Any]:
    if condition not in {"C1", "C2"}:
        raise ValueError(f"unsupported precompute condition: {condition}")
    files, monai_result = _read_monai_bundle(bundle)
    required = (
        {"segmentation"}
        if condition == "C1"
        else {"segmentation", "uncertainty", "foreground_probability"}
    )
    missing = required - set(files)
    if missing:
        raise ValueError(
            f"MONAI bundle is missing required artifacts: {sorted(missing)}"
        )

    staging_dir.mkdir(parents=True, exist_ok=False)
    artifacts: dict[str, dict[str, Any]] = {}
    for name in sorted(required):
        content = files[name]
        _validate_nifti(content, name)
        path = staging_dir / ARCHIVE_FILES[name]
        temp = path.with_name(f".{path.name}.tmp")
        with temp.open("wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        artifacts[name] = _artifact_metadata(path)

    threshold = float(monai_result.get("uncertainty_threshold", 0.5))
    operational_scores: dict[str, Any] = {
        "score": 0.0,
        "score_p95": 0.0,
        "score_fraction_above": 0.0,
        "score_mean_all": 0.0,
        "band": None,
    }
    if condition == "C2":
        operational_scores.update(
            compute_uncertainty_scores(
                staging_dir / ARCHIVE_FILES["segmentation"],
                staging_dir / ARCHIVE_FILES["uncertainty"],
                threshold=threshold,
            )
        )

    num_samples = int(monai_result["num_samples"])
    dropout_probability = float(
        monai_result.get(
            "dropout_probability",
            0.2 if condition == "C2" else 0.0,
        )
    )
    manifest = {
        "case_id": case.get("case_id") or case["study_uid"],
        "patient_id": case.get("patient_id"),
        "study_uid": case["study_uid"],
        "series_uid": case["series_uid"],
        "msd_case": case.get("msd_case"),
        "reference_available": bool(case.get("reference_available", False)),
        "modality": "CT",
        "anatomy": "spleen",
        "condition": condition,
        "task": "mcdropout_seg" if condition == "C2" else "segmentation",
        "checkpoint": {
            "model_id": monai_result["model_id"],
            "version": monai_result["model_version"],
            "sha256": monai_result["checkpoint_sha256"],
            "size_bytes": int(monai_result["checkpoint_size_bytes"]),
        },
        "num_samples": num_samples,
        "dropout_probability": dropout_probability,
        "threshold": threshold,
        "metrics_version": "ct-spleen-v1",
        "artifact_generation": str(uuid.uuid4()),
        "provenance_category": "checkpoint_experiment",
        "artifacts": artifacts,
        "operational_scores": operational_scores,
        "runtime_seconds": monai_result.get("latencies", {}),
        "monai_result": monai_result,
    }
    result_path = staging_dir / "result.json"
    result_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True, default=str) + "\n",
        encoding="utf-8",
    )
    validate_manifest(manifest, staging_dir)
    return manifest
