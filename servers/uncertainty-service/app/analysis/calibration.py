"""Calibration error metrics.

Computes ECE, MCE, ACE, and Brier score from confidence/correctness arrays.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from app.analysis.reliability import ReliabilityBins, bin_equal_mass, bin_equal_width


def ece(bins: ReliabilityBins) -> float:
    """Expected Calibration Error: sample-weighted absolute gap."""
    total = np.sum(bins.count)
    if total == 0:
        return 0.0
    valid = bins.count > 0
    weighted_gaps = np.abs(bins.mean_confidence[valid] - bins.accuracy[valid])
    weighted_gaps *= bins.count[valid].astype(float) / total
    return float(np.sum(weighted_gaps))


def mce(bins: ReliabilityBins) -> float:
    """Maximum Calibration Error: worst-bin gap."""
    valid = bins.count > 0
    gaps = np.abs(bins.mean_confidence[valid] - bins.accuracy[valid])
    return float(np.max(gaps)) if len(gaps) > 0 else 0.0


def ace(
    confidences: np.ndarray,
    correct: np.ndarray,
    n_bins: int = 15,
) -> float:
    """Adaptive Calibration Error using equal-mass bins."""
    b = bin_equal_mass(confidences, correct, n_bins=n_bins)
    return ece(b)


def brier_score(confidences: np.ndarray, correct: np.ndarray) -> float:
    """Brier score: mean squared error of confidence vs binary correctness."""
    return float(np.mean((confidences - correct.astype(float)) ** 2))


@dataclass
class CalibrationReport:
    """Aggregate calibration report from a single model evaluation."""

    n_bins: int
    equal_width: ReliabilityBins
    equal_mass: ReliabilityBins
    ece_equal_width: float
    ece_equal_mass: float
    mce_equal_width: float
    mce_equal_mass: float
    ace_value: float
    brier: float
    n_samples: int

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe dict; NaN replaced with None."""
        d = {
            "n_bins": self.n_bins,
            "n_samples": self.n_samples,
            "metrics": {
                "ece_equal_width": self.ece_equal_width,
                "ece_equal_mass": self.ece_equal_mass,
                "mce_equal_width": self.mce_equal_width,
                "mce_equal_mass": self.mce_equal_mass,
                "ace": self.ace_value,
                "brier": self.brier,
            },
        }
        # Replace NaN with None for JSON safety
        for k, v in d["metrics"].items():
            if isinstance(v, float) and np.isnan(v):
                d["metrics"][k] = None
        return d


def compute_calibration_report(
    confidences: np.ndarray,
    correct: np.ndarray,
    n_bins: int = 15,
) -> CalibrationReport:
    """Convenience: return a full CalibrationReport from raw arrays."""
    eqw = bin_equal_width(confidences, correct, n_bins=n_bins)
    eqm = bin_equal_mass(confidences, correct, n_bins=n_bins)
    return CalibrationReport(
        n_bins=n_bins,
        equal_width=eqw,
        equal_mass=eqm,
        ece_equal_width=ece(eqw),
        ece_equal_mass=ece(eqm),
        mce_equal_width=mce(eqw),
        mce_equal_mass=mce(eqm),
        ace_value=ace(confidences, correct, n_bins=n_bins),
        brier=brier_score(confidences, correct),
        n_samples=len(confidences),
    )
