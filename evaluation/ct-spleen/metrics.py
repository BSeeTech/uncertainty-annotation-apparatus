"""Metrics for checkpoint-backed CT spleen evaluation."""

from __future__ import annotations

import math
import statistics
from typing import Any

import numpy as np
from scipy.ndimage import binary_erosion, distance_transform_edt


def _trapezoid(y: np.ndarray, x: np.ndarray | None = None, *, dx: float = 1.0) -> float:
    """Integrate with the API exposed by the installed NumPy generation."""
    integrator = getattr(np, "trapezoid", None) or getattr(np, "trapz", None)
    if integrator is None:  # pragma: no cover - supported NumPy versions expose one of these
        raise RuntimeError("NumPy provides neither trapezoid nor trapz")
    return float(integrator(y, x=x, dx=dx))


def _as_bool(values: np.ndarray) -> np.ndarray:
    return np.asarray(values, dtype=bool)


def _surface(mask: np.ndarray) -> np.ndarray:
    mask = _as_bool(mask)
    if not mask.any():
        return np.zeros_like(mask)
    return mask & ~binary_erosion(mask, border_value=0)


def segmentation_metrics(
    pred: np.ndarray,
    reference: np.ndarray,
    spacing: tuple[float, ...],
) -> dict[str, float]:
    pred = _as_bool(pred)
    reference = _as_bool(reference)
    if pred.shape != reference.shape:
        raise ValueError("prediction and reference shapes differ")

    pred_count = int(pred.sum())
    reference_count = int(reference.sum())
    intersection = int(np.logical_and(pred, reference).sum())
    union = int(np.logical_or(pred, reference).sum())
    denominator = pred_count + reference_count
    dice = 1.0 if denominator == 0 else 2.0 * intersection / denominator
    jaccard = 1.0 if union == 0 else intersection / union

    pred_surface = _surface(pred)
    reference_surface = _surface(reference)
    if not pred_surface.any() and not reference_surface.any():
        hd95 = 0.0
        surface_dice = 1.0
    elif not pred_surface.any() or not reference_surface.any():
        hd95 = math.inf
        surface_dice = 0.0
    else:
        distance_to_reference = distance_transform_edt(
            ~reference_surface,
            sampling=spacing,
        )[pred_surface]
        distance_to_pred = distance_transform_edt(
            ~pred_surface,
            sampling=spacing,
        )[reference_surface]
        combined = np.concatenate((distance_to_reference, distance_to_pred))
        hd95 = float(np.percentile(combined, 95))
        surface_dice = float(
            (
                np.count_nonzero(distance_to_reference <= 2.0)
                + np.count_nonzero(distance_to_pred <= 2.0)
            )
            / (
                distance_to_reference.size
                + distance_to_pred.size
            )
        )

    voxel_volume_ml = float(np.prod(spacing)) / 1000.0
    predicted_volume = pred_count * voxel_volume_ml
    reference_volume = reference_count * voxel_volume_ml
    absolute_error = abs(predicted_volume - reference_volume)
    relative_error = (
        0.0
        if reference_volume == 0 and predicted_volume == 0
        else math.inf
        if reference_volume == 0
        else absolute_error / reference_volume
    )
    return {
        "dice": float(dice),
        "jaccard": float(jaccard),
        "hd95_mm": hd95,
        "surface_dice_2mm": surface_dice,
        "predicted_volume_ml": predicted_volume,
        "reference_volume_ml": reference_volume,
        "absolute_volume_error_ml": absolute_error,
        "relative_volume_error": relative_error,
    }


def local_evaluation_region(
    pred: np.ndarray,
    reference: np.ndarray,
    spacing: tuple[float, ...],
    dilation_mm: float = 20.0,
) -> np.ndarray:
    union = np.logical_or(_as_bool(pred), _as_bool(reference))
    if not union.any():
        return np.zeros_like(union)
    return distance_transform_edt(~union, sampling=spacing) <= dilation_mm


def calibration_metrics(
    probability: np.ndarray,
    reference: np.ndarray,
    region: np.ndarray,
) -> dict[str, float]:
    probability = np.asarray(probability, dtype=np.float64)
    reference = _as_bool(reference)
    region = _as_bool(region)
    selected_probability = probability[region]
    selected_reference = reference[region].astype(np.float64)
    if selected_probability.size == 0:
        return {"ece_15": math.nan, "brier": math.nan, "nll": math.nan}
    if np.any((selected_probability < 0) | (selected_probability > 1)):
        raise ValueError("probabilities must be in [0, 1]")

    clipped = np.clip(selected_probability, 1e-7, 1.0 - 1e-7)
    brier = float(np.mean((selected_probability - selected_reference) ** 2))
    nll = float(
        -np.mean(
            selected_reference * np.log(clipped)
            + (1.0 - selected_reference) * np.log(1.0 - clipped)
        )
    )

    edges = np.linspace(0.0, 1.0, 16)
    bin_ids = np.clip(
        np.digitize(selected_probability, edges[1:-1], right=False),
        0,
        14,
    )
    ece = 0.0
    for bin_id in range(15):
        members = bin_ids == bin_id
        if not members.any():
            continue
        confidence = float(selected_probability[members].mean())
        accuracy = float(selected_reference[members].mean())
        ece += members.mean() * abs(confidence - accuracy)
    return {"ece_15": float(ece), "brier": brier, "nll": nll}


def _average_ranks(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(values.size, dtype=np.float64)
    start = 0
    while start < values.size:
        end = start + 1
        while (
            end < values.size
            and values[order[end]] == values[order[start]]
        ):
            end += 1
        average = (start + 1 + end) / 2.0
        ranks[order[start:end]] = average
        start = end
    return ranks


def _roc_auc(scores: np.ndarray, labels: np.ndarray) -> float:
    positives = int(labels.sum())
    negatives = labels.size - positives
    if positives == 0 or negatives == 0:
        return math.nan
    ranks = _average_ranks(scores)
    positive_rank_sum = float(ranks[labels].sum())
    return (
        positive_rank_sum
        - positives * (positives + 1) / 2.0
    ) / (positives * negatives)


def _average_precision(scores: np.ndarray, labels: np.ndarray) -> float:
    positives = int(labels.sum())
    if positives == 0:
        return math.nan
    order = np.argsort(-scores, kind="mergesort")
    sorted_labels = labels[order].astype(np.int64)
    true_positives = np.cumsum(sorted_labels)
    precision = true_positives / np.arange(1, labels.size + 1)
    return float(precision[sorted_labels == 1].sum() / positives)


def uncertainty_metrics(
    entropy: np.ndarray,
    pred: np.ndarray,
    reference: np.ndarray,
    region: np.ndarray,
) -> dict[str, float]:
    entropy = np.asarray(entropy, dtype=np.float64)
    errors = np.not_equal(_as_bool(pred), _as_bool(reference))
    region = _as_bool(region)
    selected_entropy = entropy[region]
    selected_errors = errors[region]
    if selected_entropy.size == 0:
        return {
            "error_auroc": math.nan,
            "error_auprc": math.nan,
            "mean_entropy_correct": math.nan,
            "mean_entropy_error": math.nan,
            "risk_coverage_auc": math.nan,
        }

    correct_entropy = selected_entropy[~selected_errors]
    error_entropy = selected_entropy[selected_errors]
    order = np.argsort(selected_entropy, kind="mergesort")
    sorted_errors = selected_errors[order].astype(np.float64)
    cumulative_risk = np.cumsum(sorted_errors) / np.arange(
        1,
        sorted_errors.size + 1,
    )
    coverage = np.arange(1, sorted_errors.size + 1) / sorted_errors.size
    # np.trapezoid is new in NumPy 2.0; np.trapz was removed in newer NumPy.
    risk_coverage_auc = _trapezoid(cumulative_risk, coverage)

    return {
        "error_auroc": float(_roc_auc(selected_entropy, selected_errors)),
        "error_auprc": float(
            _average_precision(selected_entropy, selected_errors)
        ),
        "mean_entropy_correct": (
            float(correct_entropy.mean())
            if correct_entropy.size
            else math.nan
        ),
        "mean_entropy_error": (
            float(error_entropy.mean())
            if error_entropy.size
            else math.nan
        ),
        "risk_coverage_auc": risk_coverage_auc,
    }


def aggregate_case_metrics(
    rows: list[dict[str, Any]],
) -> dict[str, dict[str, dict[str, float]]]:
    sections = (
        "segmentation_metrics",
        "calibration_metrics",
        "uncertainty_metrics",
        "runtime_seconds",
    )
    aggregate: dict[str, dict[str, dict[str, float]]] = {}
    for section in sections:
        keys = sorted(
            {
                key
                for row in rows
                for key, value in row.get(section, {}).items()
                if isinstance(value, (int, float))
                and math.isfinite(float(value))
            }
        )
        section_result: dict[str, dict[str, float]] = {}
        for key in keys:
            values = [
                float(row[section][key])
                for row in rows
                if key in row.get(section, {})
                and math.isfinite(float(row[section][key]))
            ]
            if not values:
                continue
            section_result[key] = {
                "mean": statistics.mean(values),
                "std": statistics.stdev(values) if len(values) > 1 else 0.0,
                "median": statistics.median(values),
                "min": min(values),
                "max": max(values),
            }
        if section_result:
            aggregate[section] = section_result
    return aggregate
