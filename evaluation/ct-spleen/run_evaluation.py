"""Evaluate validated five-case C2 generations against available MSD labels."""

from __future__ import annotations

import argparse
import json
import math
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from metrics import (
    aggregate_case_metrics,
    calibration_metrics,
    local_evaluation_region,
    segmentation_metrics,
    uncertainty_metrics,
)
from verify_orthanc_mapping import load_case_mapping


EXPERIMENTAL_PROVENANCE = "checkpoint_experiment"
PLUMBING_PROVENANCE = "synthetic_plumbing_validation"


def json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _json_request(
    url: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    encoded = (
        json.dumps(body).encode("utf-8")
        if body is not None
        else None
    )
    request = urllib.request.Request(
        url,
        data=encoded,
        method=method,
        headers={"Content-Type": "application/json"} if encoded else {},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(request, timeout=60) as response:
        destination.write_bytes(response.read())


def _load_nifti(path: Path) -> tuple[np.ndarray, tuple[float, float, float]]:
    import nibabel as nib

    image = nib.as_closest_canonical(nib.load(path))
    values = np.asarray(image.dataobj)
    spacing = tuple(float(value) for value in image.header.get_zooms()[:3])
    return values, spacing


def validate_experimental_report(report: dict[str, Any]) -> None:
    if report.get("provenance_category") != EXPERIMENTAL_PROVENANCE:
        raise ValueError("experimental report has invalid provenance category")
    cases = report.get("cases")
    if not isinstance(cases, list) or len(cases) != 5:
        raise ValueError("experimental report must contain five cases")
    expected = {f"patient00{index}" for index in range(1, 6)}
    if {row.get("patient_id") for row in cases} != expected:
        raise ValueError("experimental report patient set is incomplete")
    for row in cases:
        if row.get("provenance_category") != EXPERIMENTAL_PROVENANCE:
            raise ValueError("synthetic/plumbing rows cannot enter experiment")
        for section in (
            "segmentation_metrics",
            "calibration_metrics",
            "uncertainty_metrics",
            "runtime_seconds",
        ):
            if section not in row:
                raise ValueError(f"case row is missing {section}")


def build_experimental_report(rows: list[dict[str, Any]]) -> dict[str, Any]:
    report = {
        "provenance_category": EXPERIMENTAL_PROVENANCE,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "quality_scope": {
            "patients": ["patient001", "patient002", "patient003"],
            "count": 3,
            "reason": "official MSD reference masks are available",
        },
        "workflow_scope": {
            "patients": [f"patient00{index}" for index in range(1, 6)],
            "count": 5,
        },
        "cases": rows,
        "quality_aggregates": aggregate_case_metrics(
            [row for row in rows if row["reference_mask_available"]]
        ),
        "workflow_aggregates": aggregate_case_metrics(rows),
    }
    validate_experimental_report(report)
    return report


def evaluate_case(
    case: dict[str, Any],
    *,
    service_url: str,
    references_root: Path,
) -> dict[str, Any]:
    case_id = str(case.get("case_id") or case["study_uid"])
    encoded_case = urllib.parse.quote(case_id, safe="")
    inference = _json_request(
        f"{service_url.rstrip('/')}/infer/{encoded_case}",
        method="POST",
        body={"condition": "C2"},
    )
    manifest = _json_request(inference["result_url"])
    if manifest.get("provenance_category") != EXPERIMENTAL_PROVENANCE:
        raise ValueError(f"{case_id} is not a checkpoint experiment")

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        segmentation_path = root / "segmentation.nii.gz"
        probability_path = root / "foreground_probability.nii.gz"
        uncertainty_path = root / "uncertainty.nii.gz"
        _download(inference["segmentation_url"], segmentation_path)
        _download(inference["uncertainty_url"], uncertainty_path)
        probability_url = (
            f"{service_url.rstrip('/')}/files/{encoded_case}/C2/"
            "foreground_probability.nii.gz"
        )
        _download(probability_url, probability_path)

        pred_values, spacing = _load_nifti(segmentation_path)
        probability, probability_spacing = _load_nifti(probability_path)
        entropy, entropy_spacing = _load_nifti(uncertainty_path)
        # Spacings may differ slightly due to different Restored interpolation
        # modes (nearest for segmentation, bilinear for uncertainty/probability).
        max_spacing_diff = max(
            abs(a - b)
            for a, b in zip(probability_spacing, spacing)
        ) + max(abs(a - b) for a, b in zip(entropy_spacing, spacing))
        if max_spacing_diff > 1.0:
            raise ValueError(f"{case_id} artifact spacing mismatch: "
                             f"seg={spacing} prob={probability_spacing} ent={entropy_spacing}")
        pred = pred_values > 0

        segmentation_result: dict[str, float] = {}
        calibration_result: dict[str, float] = {}
        uncertainty_result: dict[str, float] = {}
        if case["reference_available"]:
            reference_path = (
                references_root
                / "labelsTr"
                / f"{case['msd_case']}.nii.gz"
            )
            reference_values, reference_spacing = _load_nifti(reference_path)
            reference = reference_values > 0
            if pred.shape != reference.shape or spacing != reference_spacing:
                raise ValueError(f"{case_id} reference geometry mismatch")
            region = local_evaluation_region(pred, reference, spacing)
            segmentation_result = segmentation_metrics(
                pred,
                reference,
                spacing,
            )
            calibration_result = calibration_metrics(
                probability,
                reference,
                region,
            )
            uncertainty_result = uncertainty_metrics(
                entropy,
                pred,
                reference,
                region,
            )

    return {
        "patient_id": case["patient_id"],
        "case_id": case_id,
        "study_uid": case["study_uid"],
        "series_uid": case["series_uid"],
        "msd_case": case["msd_case"],
        "modality": "CT",
        "condition": "C2",
        "provenance_category": EXPERIMENTAL_PROVENANCE,
        "reference_mask_available": bool(case["reference_available"]),
        "checkpoint": manifest["checkpoint"],
        "num_samples": manifest["num_samples"],
        "dropout_probability": manifest["dropout_probability"],
        "threshold": manifest["threshold"],
        "metrics_version": manifest["metrics_version"],
        "artifact_generation": manifest["artifact_generation"],
        "artifacts": manifest["artifacts"],
        "operational_scores": manifest["operational_scores"],
        "segmentation_metrics": segmentation_result,
        "calibration_metrics": calibration_result,
        "uncertainty_metrics": uncertainty_result,
        "runtime_seconds": manifest["runtime_seconds"],
        "cache_hit": inference["cache_hit"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True, type=Path)
    parser.add_argument("--references", required=True, type=Path)
    parser.add_argument("--service", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    rows = [
        evaluate_case(
            case,
            service_url=args.service,
            references_root=args.references,
        )
        for case in load_case_mapping(args.cases)
    ]
    report = json_safe(build_experimental_report(rows))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
