"""Validation helpers for the fixed MSD-to-Orthanc CT mapping."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


EXPECTED_PATIENTS = tuple(f"patient00{index}" for index in range(1, 6))
EXPECTED_MSD_CASES = (
    "spleen_10",
    "spleen_19",
    "spleen_29",
    "spleen_1",
    "spleen_15",
)
EXPECTED_SPLITS = ("imagesTr", "imagesTr", "imagesTr", "imagesTs", "imagesTs")
EXPECTED_REFERENCES = (True, True, True, False, False)


def load_case_mapping(path: Path) -> list[dict[str, Any]]:
    values = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(values, list):
        raise ValueError("case mapping must be a JSON array")
    validate_case_mapping(values)
    return values


def validate_case_mapping(cases: list[dict[str, Any]]) -> None:
    if len(cases) != 5:
        raise ValueError("case mapping must contain exactly five cases")
    patients = [case.get("patient_id") for case in cases]
    msd_cases = [case.get("msd_case") for case in cases]
    studies = [case.get("study_uid") for case in cases]
    series = [case.get("series_uid") for case in cases]
    modalities = [case.get("modality") for case in cases]
    splits = [case.get("source_split") for case in cases]
    references = [case.get("reference_available") for case in cases]

    if tuple(patients) != EXPECTED_PATIENTS:
        raise ValueError(f"unexpected patient order: {patients}")
    if tuple(msd_cases) != EXPECTED_MSD_CASES:
        raise ValueError(f"unexpected MSD case order: {msd_cases}")
    if tuple(splits) != EXPECTED_SPLITS:
        raise ValueError(f"unexpected MSD source splits: {splits}")
    if tuple(references) != EXPECTED_REFERENCES:
        raise ValueError(f"unexpected reference availability: {references}")
    if len(set(studies)) != 5 or any(not value for value in studies):
        raise ValueError("study UIDs must be present and unique")
    if len(set(series)) != 5 or any(not value for value in series):
        raise ValueError("series UIDs must be present and unique")
    if any(value != "CT" for value in modalities):
        raise ValueError("all evaluation mappings must be CT")


def compare_nifti_sources(
    source_path: Path,
    converted_path: Path,
    *,
    intensity_tolerance_hu: float = 1.0,
    spacing_tolerance_mm: float = 1e-4,
) -> dict[str, Any]:
    import nibabel as nib
    import numpy as np

    source = nib.as_closest_canonical(nib.load(source_path))
    converted = nib.as_closest_canonical(nib.load(converted_path))
    if source.shape != converted.shape:
        raise ValueError(
            f"geometry shape mismatch: {source.shape} != {converted.shape}"
        )

    source_spacing = tuple(float(value) for value in source.header.get_zooms()[:3])
    converted_spacing = tuple(
        float(value) for value in converted.header.get_zooms()[:3]
    )
    if any(
        not math.isclose(left, right, abs_tol=spacing_tolerance_mm)
        for left, right in zip(source_spacing, converted_spacing)
    ):
        raise ValueError(
            f"geometry spacing mismatch: {source_spacing} != {converted_spacing}"
        )

    source_values = np.asarray(source.dataobj, dtype=np.float32)
    converted_values = np.asarray(converted.dataobj, dtype=np.float32)
    max_difference = float(np.max(np.abs(source_values - converted_values)))
    if max_difference > intensity_tolerance_hu:
        raise ValueError(
            "intensity mismatch exceeds tolerance: "
            f"{max_difference} > {intensity_tolerance_hu} HU"
        )
    return {
        "shape": list(source.shape),
        "spacing": [round(value, 6) for value in source_spacing],
        "max_abs_hu_difference": max_difference,
    }
