"""Plotting helpers for calibration analysis.

Lazy matplotlib import so the rest of the analysis package loads quickly.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from app.analysis.reliability import ReliabilityBins


class CalibrationPlotsUnavailable(RuntimeError):
    """Raised when matplotlib is not installed."""


def plot_reliability_diagram(
    bins: ReliabilityBins,
    output_path: str | Path,
) -> str:
    """Reliability diagram: per-bin accuracy vs mean confidence."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        raise CalibrationPlotsUnavailable("matplotlib is not installed")

    fig, ax = plt.subplots(figsize=(8, 6))
    valid = bins.count > 0
    x = bins.mean_confidence[valid]
    y = bins.accuracy[valid]
    ax.plot([0, 1], [0, 1], "k--", label="Perfect calibration", alpha=0.6)
    ax.bar(x, y, width=np.diff(bins.edges)[valid][:len(x)] if np.any(valid) else 0.1,
           alpha=0.7, label="Model", color="steelblue")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_xlabel("Confidence")
    ax.set_ylabel("Accuracy")
    ax.set_title("Reliability Diagram")
    ax.legend()
    fig.tight_layout()
    fig.savefig(str(output_path), dpi=150)
    plt.close(fig)
    return str(output_path)


def plot_confidence_histogram(
    confidences: np.ndarray,
    output_path: str | Path,
    n_bins: int = 20,
) -> str:
    """Confidence histogram."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        raise CalibrationPlotsUnavailable("matplotlib is not installed")

    fig, ax = plt.subplots(figsize=(8, 4))
    ax.hist(confidences, bins=n_bins, range=(0, 1), alpha=0.7, color="steelblue")
    ax.set_xlabel("Confidence")
    ax.set_ylabel("Count")
    ax.set_title("Confidence Histogram")
    fig.tight_layout()
    fig.savefig(str(output_path), dpi=150)
    plt.close(fig)
    return str(output_path)
