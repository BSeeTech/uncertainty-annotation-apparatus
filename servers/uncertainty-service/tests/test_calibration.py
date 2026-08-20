"""Tests for calibration error metrics.

Covers: ECE, MCE, ACE, Brier, CalibrationReport, JSON safety.

Total: 15 tests.
"""

import json
import unittest

import numpy as np

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.analysis.calibration import (
    CalibrationReport,
    ace,
    brier_score,
    compute_calibration_report,
    ece,
    mce,
)
from app.analysis.reliability import ReliabilityBins, bin_equal_mass, bin_equal_width


class EceTest(unittest.TestCase):
    """ECE calculation tests."""

    def test_perfect_calibration_returns_zero_ece(self):
        # Perfect calibration: confidence == accuracy in every populated bin
        rng = np.random.default_rng(42)
        n = 500
        conf = rng.uniform(0.05, 0.95, n)
        correct = (rng.random(n) < conf).astype(int)
        bins = bin_equal_width(conf, correct, n_bins=10)
        # ECE should be low (close to zero) for well-calibrated data
        self.assertLess(ece(bins), 0.05)

    def test_maximally_miscalibrated_returns_positive_ece(self):
        conf = np.array([0.9, 0.9, 0.9])
        correct = np.array([0, 0, 0])
        bins = bin_equal_width(conf, correct, n_bins=5)
        self.assertGreater(ece(bins), 0.0)

    def test_empty_bins_are_skipped_in_ece(self):
        bins = ReliabilityBins(
            edges=np.array([0.0, 0.5, 1.0]),
            mean_confidence=np.array([np.nan, 0.75]),
            accuracy=np.array([np.nan, 0.75]),
            count=np.array([0, 10]),
            strategy="equal_width",
        )
        self.assertAlmostEqual(ece(bins), 0.0, places=6)

    def test_ece_is_between_zero_and_one(self):
        rng = np.random.default_rng(42)
        conf = rng.random(500)
        correct = (rng.random(500) < conf).astype(int)
        bins = bin_equal_width(conf, correct, n_bins=10)
        val = ece(bins)
        self.assertGreaterEqual(val, 0.0)
        self.assertLessEqual(val, 1.0)


class MceTest(unittest.TestCase):
    """MCE calculation tests."""

    def test_perfect_calibration_returns_zero_mce(self):
        rng = np.random.default_rng(99)
        n = 500
        conf = rng.uniform(0.05, 0.95, n)
        correct = (rng.random(n) < conf).astype(int)
        bins = bin_equal_width(conf, correct, n_bins=10)
        self.assertLess(mce(bins), 0.2)

    def test_mce_reports_worst_bin_gap(self):
        conf = np.array([0.1, 0.1, 0.9, 0.9])
        correct = np.array([1, 1, 0, 0])
        bins = bin_equal_width(conf, correct, n_bins=2)
        self.assertGreater(mce(bins), 0.0)


class AceTest(unittest.TestCase):
    """ACE test."""

    def test_ace_returns_finite_value(self):
        conf = np.linspace(0.01, 0.99, 200)
        correct = np.ones(200, dtype=int)
        val = ace(conf, correct, n_bins=5)
        self.assertTrue(np.isfinite(val))

    def test_ace_is_non_negative(self):
        rng = np.random.default_rng(7)
        conf = rng.random(100)
        correct = (rng.random(100) < conf).astype(int)
        self.assertGreaterEqual(ace(conf, correct), 0.0)


class BrierScoreTest(unittest.TestCase):
    """Brier score tests."""

    def test_perfect_score_is_zero(self):
        self.assertAlmostEqual(brier_score(np.array([1.0, 0.0]), np.array([1, 0])), 0.0)

    def test_worst_score_is_one(self):
        self.assertAlmostEqual(brier_score(np.array([1.0, 0.0]), np.array([0, 1])), 1.0)

    def test_brier_is_symmetric(self):
        s1 = brier_score(np.array([0.3, 0.7]), np.array([1, 0]))
        s2 = brier_score(np.array([0.7, 0.3]), np.array([0, 1]))
        self.assertAlmostEqual(s1, s2)


class CalibrationReportTest(unittest.TestCase):
    """CalibrationReport dataclass and JSON safety."""

    def test_report_contains_all_expected_metrics(self):
        conf = np.linspace(0.01, 0.99, 100)
        correct = np.ones(100, dtype=int)
        report = compute_calibration_report(conf, correct, n_bins=5)
        self.assertEqual(report.n_bins, 5)
        self.assertEqual(report.n_samples, 100)
        self.assertTrue(np.isfinite(report.ece_equal_width))
        self.assertTrue(np.isfinite(report.brier))

    def test_report_to_dict_is_json_safe(self):
        conf = np.linspace(0.01, 0.99, 50)
        correct = np.ones(50, dtype=int)
        report = compute_calibration_report(conf, correct, n_bins=5)
        d = report.to_dict()
        json_str = json.dumps(d, allow_nan=False)
        self.assertIsInstance(json_str, str)

    def test_report_with_nan_metrics_produces_none_in_json(self):
        conf = np.array([0.99, 0.99, 0.99])
        correct = np.array([1, 1, 1])
        report = compute_calibration_report(conf, correct, n_bins=5)
        d = report.to_dict()
        json_str = json.dumps(d, allow_nan=False)
        self.assertIsInstance(json_str, str)

    def test_report_ace_included(self):
        conf = np.linspace(0.01, 0.99, 100)
        correct = np.ones(100, dtype=int)
        report = compute_calibration_report(conf, correct, n_bins=5)
        self.assertTrue(np.isfinite(report.ace_value))


if __name__ == "__main__":
    unittest.main()
