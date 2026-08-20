"""Validation and API projection for complete inference result manifests."""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote


class ManifestValidationError(ValueError):
    """Raised when a cached inference result is incomplete or inconsistent."""


OFFICIAL_CHECKPOINT = {
    "model_id": "monailabel-radiology-spleen-unet",
    "version": "pretrained/radiology_segmentation_unet_spleen_total_seg.pt",
    "sha256": "b606697f9efad300bbb3b1115abd1245b29e5de0c9de8fac052ab6d2d94f920a",
    "size_bytes": 19297197,
}


REQUIRED_FIELDS = {
    "case_id",
    "patient_id",
    "study_uid",
    "series_uid",
    "modality",
    "anatomy",
    "condition",
    "task",
    "checkpoint",
    "num_samples",
    "dropout_probability",
    "threshold",
    "metrics_version",
    "artifact_generation",
    "provenance_category",
    "artifacts",
    "operational_scores",
    "runtime_seconds",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        values = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManifestValidationError(
            f"unable to read result manifest: {path}"
        ) from exc
    if not isinstance(values, dict):
        raise ManifestValidationError("result manifest must be a JSON object")
    return values


def _validate_checkpoint(checkpoint: Any) -> None:
    if not isinstance(checkpoint, dict):
        raise ManifestValidationError("checkpoint metadata must be an object")
    required = {"model_id", "version", "sha256", "size_bytes"}
    missing = required - set(checkpoint)
    if missing:
        raise ManifestValidationError(
            f"checkpoint metadata missing fields: {sorted(missing)}"
        )
    if not re.fullmatch(r"[0-9a-f]{64}", str(checkpoint["sha256"])):
        raise ManifestValidationError("checkpoint SHA-256 is malformed")
    if (
        not isinstance(checkpoint["size_bytes"], int)
        or checkpoint["size_bytes"] <= 0
    ):
        raise ManifestValidationError("checkpoint size must be positive")
    mismatched = {
        field: (checkpoint[field], expected)
        for field, expected in OFFICIAL_CHECKPOINT.items()
        if checkpoint[field] != expected
    }
    if mismatched:
        raise ManifestValidationError(
            "checkpoint metadata does not match the installed official "
            f"checkpoint: {mismatched}"
        )


def _required_artifacts(condition: str) -> set[str]:
    if condition == "C1":
        return {"segmentation"}
    if condition == "C2":
        return {
            "segmentation",
            "uncertainty",
            "foreground_probability",
        }
    raise ManifestValidationError(f"unsupported AI condition: {condition}")


def validate_manifest(manifest: dict[str, Any], root: Path) -> None:
    missing = REQUIRED_FIELDS - set(manifest)
    if missing:
        raise ManifestValidationError(
            f"result manifest missing fields: {sorted(missing)}"
        )
    if manifest["modality"] != "CT" or manifest["anatomy"] != "spleen":
        raise ManifestValidationError(
            "result manifest must describe CT spleen inference"
        )
    if manifest["provenance_category"] != "checkpoint_experiment":
        raise ManifestValidationError(
            "experimental result has invalid provenance category"
        )
    condition = str(manifest["condition"])
    if condition == "C1":
        if manifest["task"] != "segmentation":
            raise ManifestValidationError("C1 task must be segmentation")
        if manifest["num_samples"] != 1:
            raise ManifestValidationError("C1 must report one sample")
        if float(manifest["dropout_probability"]) != 0.0:
            raise ManifestValidationError("C1 dropout must be zero")
    elif condition == "C2":
        if manifest["task"] != "mcdropout_seg":
            raise ManifestValidationError("C2 task must be mcdropout_seg")
        if manifest["num_samples"] != 16:
            raise ManifestValidationError("C2 must report T=16")
        if not math.isclose(
            float(manifest["dropout_probability"]),
            0.2,
        ):
            raise ManifestValidationError("C2 dropout must be 0.2")
    else:
        raise ManifestValidationError(f"unsupported condition: {condition}")

    _validate_checkpoint(manifest["checkpoint"])
    artifacts = manifest["artifacts"]
    if not isinstance(artifacts, dict):
        raise ManifestValidationError("artifacts must be an object")
    required_artifacts = _required_artifacts(condition)
    if set(artifacts) != required_artifacts:
        raise ManifestValidationError(
            "artifact set does not match condition: "
            f"{sorted(artifacts)} != {sorted(required_artifacts)}"
        )

    for name, metadata in artifacts.items():
        if not isinstance(metadata, dict):
            raise ManifestValidationError(
                f"{name} artifact metadata must be an object"
            )
        required = {"filename", "sha256", "size_bytes", "media_type"}
        missing_artifact = required - set(metadata)
        if missing_artifact:
            raise ManifestValidationError(
                f"{name} artifact missing fields: {sorted(missing_artifact)}"
            )
        filename = str(metadata["filename"])
        if Path(filename).name != filename:
            raise ManifestValidationError(
                f"{name} artifact filename is unsafe"
            )
        path = root / filename
        if not path.is_file():
            raise ManifestValidationError(
                f"{name} artifact is missing: {filename}"
            )
        measured_size = path.stat().st_size
        if measured_size != metadata["size_bytes"]:
            raise ManifestValidationError(
                f"{name} artifact size mismatch"
            )
        measured_hash = sha256_file(path)
        if measured_hash != metadata["sha256"]:
            raise ManifestValidationError(
                f"{name} artifact SHA-256 mismatch"
            )


def manifest_to_inference_response(
    manifest: dict[str, Any],
    base_url: str,
    *,
    cache_hit: bool,
) -> dict[str, Any]:
    base_url = base_url.rstrip("/")
    case_id = quote(str(manifest["case_id"]), safe="")
    condition = str(manifest["condition"])
    files_root = f"{base_url}/files/{case_id}/{condition}"
    scores = manifest["operational_scores"]
    checkpoint = manifest["checkpoint"]
    uncertainty_url = (
        f"{files_root}/uncertainty.nii.gz"
        if condition == "C2"
        else None
    )
    return {
        "case_id": manifest["case_id"],
        "task": manifest["task"],
        "monai_label_reachable": False,
        "segmentation_url": f"{files_root}/segmentation.nii.gz",
        "uncertainty_url": uncertainty_url,
        "model_version": checkpoint["version"],
        "checkpoint_version": checkpoint["version"],
        "checkpoint_sha256": checkpoint["sha256"],
        "num_samples": manifest["num_samples"],
        "dropout_probability": manifest["dropout_probability"],
        "score": float(scores.get("score", 0.0)),
        "score_p95": float(scores.get("score_p95", 0.0)),
        "score_fraction_above": float(
            scores.get("score_fraction_above", 0.0)
        ),
        "score_mean_all": float(scores.get("score_mean_all", 0.0)),
        "threshold": float(manifest["threshold"]),
        "band": scores.get("band"),
        "inference_status": scores.get("inference_status", "completed"),
        "metrics_version": manifest["metrics_version"],
        "artifact_generation": manifest["artifact_generation"],
        "result_url": (
            f"{base_url}/results/{case_id}?condition={condition}"
        ),
        "cache_hit": cache_hit,
    }
