"""Reliability binning for calibration analysis.

Two binning strategies:
- bin_equal_width: fixed-width confidence bins.
- bin_equal_mass: equal-count (adaptive-width) bins.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np


@dataclass(frozen=True)
class ReliabilityBins:
    """Frozen dataclass of aligned bin statistics.

    Empty bins have count == 0 and NaN mean_confidence / accuracy.
    """

    edges: np.ndarray  # (n_bins + 1,) bin boundaries in [0, 1]
    mean_confidence: np.ndarray  # (n_bins,)
    accuracy: np.ndarray  # (n_bins,)
    count: np.ndarray  # (n_bins,) integer counts
    strategy: Literal["equal_width", "equal_mass"]


def bin_equal_width(
    confidences: np.ndarray,
    correct: np.ndarray,
    n_bins: int = 15,
) -> ReliabilityBins:
    """Fixed-width binning in [0, 1].

    Confidence exactly equal to 1.0 is placed into the top bin rather than
    out of range (the naive np.digitize behaviour).
    """
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    indices = np.digitize(confidences, edges, right=False) - 1
    # Clip 1.0 into top bin
    indices = np.clip(indices, 0, n_bins - 1)

    n_bins_actual = n_bins
    mean_confidence = np.full(n_bins_actual, np.nan)
    accuracy = np.full(n_bins_actual, np.nan)
    count = np.zeros(n_bins_actual, dtype=np.int64)

    for i in range(n_bins_actual):
        mask = indices == i
        cnt = np.sum(mask)
        count[i] = cnt
        if cnt > 0:
            mean_confidence[i] = np.mean(confidences[mask])
            accuracy[i] = np.mean(correct[mask])

    return ReliabilityBins(
        edges=edges,
        mean_confidence=mean_confidence,
        accuracy=accuracy,
        count=count,
        strategy="equal_width",
    )


def bin_equal_mass(
    confidences: np.ndarray,
    correct: np.ndarray,
    n_bins: int = 15,
) -> ReliabilityBins:
    """Equal-mass (adaptive-width) binning.

    Boundaries are empirical quantiles of confidence values.  If quantile
    edges collapse (many samples share the same confidence), the corresponding
    bins end up empty and are NaN-marked.
    """
    n = len(confidences)
    edges = np.quantile(
        confidences,
        np.linspace(0.0, 1.0, n_bins + 1),
    )
    # Ensure strictly increasing edges
    edges = np.unique(edges)
    indices = np.digitize(confidences, edges, right=False) - 1
    indices = np.clip(indices, 0, len(edges) - 2)

    n_bins_actual = len(edges) - 1
    mean_confidence = np.full(n_bins_actual, np.nan)
    accuracy = np.full(n_bins_actual, np.nan)
    count = np.zeros(n_bins_actual, dtype=np.int64)

    for i in range(n_bins_actual):
        mask = indices == i
        cnt = np.sum(mask)
        count[i] = cnt
        if cnt > 0:
            mean_confidence[i] = np.mean(confidences[mask])
            accuracy[i] = np.mean(correct[mask])

    return ReliabilityBins(
        edges=edges,
        mean_confidence=mean_confidence,
        accuracy=accuracy,
        count=count,
        strategy="equal_mass",
    )
