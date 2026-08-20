"""CLI entry point for calibration analysis.

Invocation:
    python -m app.analysis.cli \\
        --inputs predictions.npz \\
        --output report.json \\
        [--n-bins 15] \\
        [--temperature] \\
        [--plots-dir reliability_plots/]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from app.analysis.calibration import (
    compute_calibration_report,
)
from app.analysis.reliability import bin_equal_mass, bin_equal_width
from app.analysis.temperature import apply_temperature, fit_temperature


def _load_predictions(inputs_path: str) -> dict:
    """Load predictions from .npz, handling both softmax and pre-reduced formats."""
    data = np.load(inputs_path)
    result = {}
    for key in ("softmax", "logits", "confidences", "correct", "labels"):
        if key in data:
            result[key] = data[key]
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Calibration analysis CLI"
    )
    parser.add_argument("--inputs", required=True, help="Path to predictions.npz")
    parser.add_argument("--output", required=True, help="Path to output report.json")
    parser.add_argument("--n-bins", type=int, default=15, help="Number of bins")
    parser.add_argument("--temperature", action="store_true", help="Run temperature scaling")
    parser.add_argument("--plots-dir", type=str, default=None, help="Directory for plots")
    args = parser.parse_args(argv)

    inputs_path = Path(args.inputs)
    output_path = Path(args.output)

    if not inputs_path.exists():
        print(f"ERROR: input file not found: {inputs_path}", file=sys.stderr)
        return 1

    data = _load_predictions(str(inputs_path))

    # Determine confidences and correct from available arrays
    if "confidences" in data and "correct" in data:
        confidences = data["confidences"]
        correct = data["correct"]
    elif "softmax" in data and "labels" in data:
        softmax_vals = data["softmax"]
        labels = data["labels"]
        confidences = np.max(softmax_vals, axis=1)
        correct = (np.argmax(softmax_vals, axis=1) == labels).astype(int)
    else:
        print(
            "ERROR: predictions.npz must contain either (softmax, labels) or (confidences, correct)",
            file=sys.stderr,
        )
        return 1

    # Compute calibration report
    report = compute_calibration_report(confidences, correct, n_bins=args.n_bins)
    report_dict = report.to_dict()

    # Temperature scaling
    if args.temperature:
        if "logits" not in data:
            print(
                "ERROR: --temperature requires logits array in predictions.npz",
                file=sys.stderr,
            )
            return 1
        logits = data["logits"]
        labels = data.get("labels", np.argmax(data.get("softmax", logits), axis=1))
        fit = fit_temperature(logits, labels)
        report_dict["temperature_fit"] = {
            "temperature": fit.temperature,
            "nll_before": fit.nll_before,
            "nll_after": fit.nll_after,
            "converged": fit.converged,
        }
        # Post-calibration metrics under rescaled probabilities
        calibrated_probs = apply_temperature(logits, fit.temperature)
        cal_conf = np.max(calibrated_probs, axis=1)
        cal_correct = (np.argmax(calibrated_probs, axis=1) == labels).astype(int)
        cal_report = compute_calibration_report(cal_conf, cal_correct, n_bins=args.n_bins)
        report_dict["post_calibration"] = cal_report.to_dict()

    # Generate plots if requested
    if args.plots_dir:
        plots_path = Path(args.plots_dir)
        plots_path.mkdir(parents=True, exist_ok=True)
        try:
            from app.analysis.plots import CalibrationPlotsUnavailable, plot_confidence_histogram, plot_reliability_diagram

            bins = bin_equal_width(confidences, correct, n_bins=args.n_bins)
            reliability_path = str(plots_path / "reliability_diagram.png")
            plot_reliability_diagram(bins, reliability_path)
            hist_path = str(plots_path / "confidence_histogram.png")
            plot_confidence_histogram(confidences, hist_path)
            report_dict["plots"] = {
                "reliability_diagram": reliability_path,
                "confidence_histogram": hist_path,
            }
        except ImportError:
            print("WARNING: matplotlib not available; skipping plots", file=sys.stderr)
        except CalibrationPlotsUnavailable as e:
            print(f"WARNING: {e}; skipping plots", file=sys.stderr)

    # Write output
    with open(output_path, "w") as f:
        json.dump(report_dict, f, indent=2, allow_nan=False)

    return 0


if __name__ == "__main__":
    sys.exit(main())
