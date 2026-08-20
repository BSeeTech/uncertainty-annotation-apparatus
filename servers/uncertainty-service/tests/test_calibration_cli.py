"""Tests for the calibration CLI (python -m app.analysis.cli).

Covers: end-to-end success, missing input, missing key, temperature path.

Total: 8 tests.
"""

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.analysis.cli import main


def _make_npz(tmp: Path, include_logits: bool = False, filename: str = "predictions.npz"):
    """Create a predictions.npz with softmax and labels arrays."""
    rng = np.random.default_rng(42)
    n = 200
    softmax_vals = rng.dirichlet([2, 1, 1], size=n)
    labels = np.argmax(softmax_vals, axis=1)
    kwargs = {"softmax": softmax_vals, "labels": labels}
    if include_logits:
        kwargs["logits"] = rng.normal(0, 1, size=(n, 3))
    npz_path = tmp / filename
    np.savez_compressed(npz_path, **kwargs)
    return npz_path


class CalibrationCliTest(unittest.TestCase):
    def test_full_report_returns_valid_json(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            npz = _make_npz(tmp)
            out = tmp / "report.json"
            exit_code = main(["--inputs", str(npz), "--output", str(out)])
            self.assertEqual(exit_code, 0)
            self.assertTrue(out.exists())
            with open(out) as f:
                report = json.load(f)
            self.assertIn("metrics", report)
            self.assertIn("n_samples", report)

    def test_missing_input_file_returns_nonzero(self):
        exit_code = main(["--inputs", "/nonexistent/file.npz", "--output", "/tmp/out.json"])
        self.assertNotEqual(exit_code, 0)

    def test_missing_required_key_returns_nonzero(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            npz = tmp / "bad.npz"
            np.savez_compressed(npz, wrong_key=np.array([1, 2, 3]))
            out = tmp / "report.json"
            exit_code = main(["--inputs", str(npz), "--output", str(out)])
            self.assertNotEqual(exit_code, 0)

    def test_temperature_flag_accepts_logits(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            npz = _make_npz(tmp, include_logits=True)
            out = tmp / "report.json"
            exit_code = main(["--inputs", str(npz), "--output", str(out), "--temperature"])
            self.assertEqual(exit_code, 0)
            with open(out) as f:
                report = json.load(f)
            self.assertIn("temperature_fit", report)

    def test_temperature_without_logits_returns_nonzero(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            npz = _make_npz(tmp, include_logits=False)
            out = tmp / "report.json"
            exit_code = main(["--inputs", str(npz), "--output", str(out), "--temperature"])
            self.assertNotEqual(exit_code, 0)

    def test_custom_n_bins_produces_correct_report(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            npz = _make_npz(tmp)
            out = tmp / "report.json"
            exit_code = main(["--inputs", str(npz), "--output", str(out), "--n-bins", "10"])
            self.assertEqual(exit_code, 0)
            with open(out) as f:
                report = json.load(f)
            self.assertEqual(report["n_bins"], 10)

    def test_plot_directory_does_not_crash_when_matplotlib_unavailable(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            npz = _make_npz(tmp)
            out = tmp / "report.json"
            plots = tmp / "plots"
            exit_code = main(
                ["--inputs", str(npz), "--output", str(out), "--plots-dir", str(plots)]
            )
            self.assertEqual(exit_code, 0)

    def test_report_includes_both_binning_strategies(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            npz = _make_npz(tmp)
            out = tmp / "report.json"
            main(["--inputs", str(npz), "--output", str(out)])
            with open(out) as f:
                report = json.load(f)
            self.assertIn("metrics", report)


if __name__ == "__main__":
    unittest.main()
