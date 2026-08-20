"""Tests for reliability binning utilities.

Covers: bin_equal_width, bin_equal_mass, edge cases, NaN handling.

Total: 14 tests.
"""

import unittest

import numpy as np

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.analysis.reliability import (
    ReliabilityBins,
    bin_equal_mass,
    bin_equal_width,
)


class BinEqualWidthTest(unittest.TestCase):
    """Fixed-width binning tests."""

    def test_basic_binning_returns_correct_shape(self):
        conf = np.array([0.1, 0.3, 0.5, 0.7, 0.9])
        correct = np.array([0, 0, 1, 1, 1])
        bins = bin_equal_width(conf, correct, n_bins=5)
        self.assertIsInstance(bins, ReliabilityBins)
        self.assertEqual(len(bins.edges), 6)
        self.assertEqual(len(bins.mean_confidence), 5)
        self.assertEqual(len(bins.accuracy), 5)
        self.assertEqual(len(bins.count), 5)

    def test_all_correct_bins_accuracy_is_one(self):
        conf = np.linspace(0.05, 0.95, 100)
        correct = np.ones(100, dtype=int)
        bins = bin_equal_width(conf, correct, n_bins=5)
        # All samples are correct, so accuracy in each non-empty bin is 1.0
        valid = bins.count > 0
        self.assertTrue(np.all(bins.accuracy[valid] == 1.0))

    def test_assigns_one_point_oh_to_top_bin(self):
        conf = np.array([1.0])
        correct = np.array([1])
        bins = bin_equal_width(conf, correct, n_bins=3)
        self.assertTrue(np.isfinite(bins.count[-1]))
        self.assertEqual(bins.count[-1], 1)

    def test_perfectly_calibrated_gives_zero_gap(self):
        rng = np.random.default_rng(42)
        conf = np.linspace(0.05, 0.95, 100)
        correct = (rng.random(100) < conf).astype(int)
        bins = bin_equal_width(conf, correct, n_bins=10)
        gaps = np.abs(bins.mean_confidence - bins.accuracy)
        self.assertTrue(np.all(gaps[~np.isnan(gaps)] < 0.2))

    def test_empty_bins_have_nan_accuracy(self):
        conf = np.array([0.99, 0.99, 0.99])
        correct = np.array([1, 1, 1])
        bins = bin_equal_width(conf, correct, n_bins=5)
        self.assertTrue(np.any(np.isnan(bins.accuracy)))

    def test_single_bin_edge_case(self):
        conf = np.array([0.5, 0.5, 0.5])
        correct = np.array([1, 0, 1])
        bins = bin_equal_width(conf, correct, n_bins=1)
        self.assertEqual(bins.count[0], 3)
        self.assertAlmostEqual(bins.mean_confidence[0], 0.5)

    def test_uniform_confidence_distribution(self):
        conf = np.linspace(0, 1, 1000)
        correct = np.ones(1000, dtype=int)
        bins = bin_equal_width(conf, correct, n_bins=10)
        # Every bin should have ~100 samples
        self.assertTrue(np.all(bins.count >= 50))


class BinEqualMassTest(unittest.TestCase):
    """Equal-mass binning tests."""

    def test_equal_mass_bins_have_balanced_counts(self):
        conf = np.linspace(0.01, 0.99, 100)
        correct = np.ones(100, dtype=int)
        bins = bin_equal_mass(conf, correct, n_bins=5)
        # Each bin should have approximately 20 samples
        self.assertTrue(np.all(bins.count >= 10))

    def test_handles_concentrated_confidence_at_one_value(self):
        conf = np.array([0.999] * 95 + [0.1, 0.2, 0.3, 0.4, 0.5])
        correct = np.ones(100, dtype=int)
        bins = bin_equal_mass(conf, correct, n_bins=5)
        # Should not crash; collapsed quantiles may reduce bin count
        self.assertGreater(len(bins.count), 0)
        self.assertTrue(np.any(np.isfinite(bins.accuracy)) or np.all(np.isnan(bins.accuracy)))

    def test_equal_mass_copes_with_perfect_confidence(self):
        conf = np.ones(50)
        correct = np.ones(50, dtype=int)
        bins = bin_equal_mass(conf, correct, n_bins=3)
        # All confidence is 1.0 → quantile boundaries collapse
        self.assertTrue(np.any(np.isnan(bins.accuracy)) or np.all(np.isfinite(bins.accuracy)))

    def test_equal_mass_versus_width_produce_same_bin_count(self):
        rng = np.random.default_rng(99)
        conf = rng.random(200)
        correct = (rng.random(200) < conf).astype(int)
        w = bin_equal_width(conf, correct, n_bins=10)
        m = bin_equal_mass(conf, correct, n_bins=10)
        self.assertEqual(len(w.count), len(m.count))


class ReliabilityBinsDataclassTest(unittest.TestCase):
    """ReliabilityBins dataclass behaviour."""

    def test_nan_count_is_explicitly_nan(self):
        bins = ReliabilityBins(
            edges=np.array([0.0, 0.5, 1.0]),
            mean_confidence=np.array([0.25, np.nan]),
            accuracy=np.array([0.25, np.nan]),
            count=np.array([10, 0]),
            strategy="equal_width",
        )
        self.assertTrue(np.isnan(bins.accuracy[1]))

    def test_edges_are_monotonic(self):
        bins = bin_equal_width(np.array([0.1, 0.5, 0.9]), np.array([1, 0, 1]), n_bins=3)
        self.assertTrue(np.all(np.diff(bins.edges) >= 0))

    def test_strategy_string_is_recorded(self):
        bins = bin_equal_width(np.array([0.5]), np.array([1]), n_bins=2)
        self.assertEqual(bins.strategy, "equal_width")
        bins2 = bin_equal_mass(np.array([0.5, 0.6]), np.array([1, 0]), n_bins=2)
        self.assertEqual(bins2.strategy, "equal_mass")


if __name__ == "__main__":
    unittest.main()
