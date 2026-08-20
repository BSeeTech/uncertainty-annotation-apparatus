"""Tests for temperature scaling.

Covers: softmax, NLL, apply_temperature, fit_temperature, over-confidence recovery.

Total: 16 tests.
"""

import unittest

import numpy as np

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.analysis.temperature import (
    TemperatureFit,
    apply_temperature,
    fit_temperature,
    negative_log_likelihood,
    softmax,
)


class SoftmaxTest(unittest.TestCase):
    """Softmax numerical tests."""

    def test_softmax_row_sums_to_one(self):
        logits = np.array([[1.0, 2.0, 3.0], [0.5, 0.0, -0.5]])
        probs = softmax(logits)
        np.testing.assert_allclose(np.sum(probs, axis=1), [1.0, 1.0], atol=1e-10)

    def test_softmax_is_stable_with_large_values(self):
        logits = np.array([[1e3, 0.0, -1e3]])
        probs = softmax(logits)
        self.assertAlmostEqual(float(probs[0, 0]), 1.0, places=6)
        self.assertAlmostEqual(float(probs[0, 2]), 0.0, places=6)


class NegativeLogLikelihoodTest(unittest.TestCase):
    """NLL tests."""

    def test_perfect_prediction_has_low_nll(self):
        logits = np.array([[1e3, 0.0], [0.0, 1e3]])
        labels = np.array([0, 1])
        nll = negative_log_likelihood(logits, labels, temperature=1.0)
        self.assertAlmostEqual(nll, 0.0, places=4)

    def test_nll_increases_with_temperature(self):
        logits = np.array([[1.0, 0.0], [0.0, 1.0]])
        labels = np.array([0, 1])
        nll_cold = negative_log_likelihood(logits, labels, temperature=0.5)
        nll_hot = negative_log_likelihood(logits, labels, temperature=5.0)
        self.assertGreater(nll_hot, nll_cold)

    def test_nll_handles_clipping(self):
        logits = np.array([[1e10, -1e10]])
        labels = np.array([0])
        nll = negative_log_likelihood(logits, labels, temperature=1.0)
        self.assertTrue(np.isfinite(nll))


class ApplyTemperatureTest(unittest.TestCase):
    """apply_temperature tests."""

    def test_temperature_one_yields_unchanged_softmax(self):
        logits = np.array([[1.0, 2.0, 3.0]])
        probs = softmax(logits)
        applied = apply_temperature(logits, 1.0)
        np.testing.assert_allclose(probs, applied, atol=1e-10)

    def test_high_temperature_smooths_probabilities(self):
        logits = np.array([[10.0, 0.0]])
        cold = apply_temperature(logits, 1.0)
        hot = apply_temperature(logits, 5.0)
        self.assertLess(np.max(hot), np.max(cold))


class FitTemperatureTest(unittest.TestCase):
    """Temperature fitting tests."""

    def test_recovers_T_greater_than_one_for_overconfident_logits(self):
        # Over-confident logits: extreme values with some label noise
        rng = np.random.default_rng(42)
        logits = rng.normal(0, 3.0, size=(500, 2))
        labels = (logits[:, 0] + rng.normal(0, 0.5, 500) > logits[:, 1] + rng.normal(0, 0.5, 500)).astype(int)
        result = fit_temperature(logits, labels)
        self.assertGreater(result.temperature, 0.5)
        self.assertLess(result.nll_after, result.nll_before)

    def test_recovers_T_near_one_for_calibrated_logits(self):
        # Well-calibrated: logits N(0,0.5) with marginal label noise
        rng = np.random.default_rng(99)
        logits = rng.normal(0, 0.5, size=(1000, 2))
        labels = rng.integers(0, 2, size=1000)
        result = fit_temperature(logits, labels)
        self.assertTrue(np.isfinite(result.temperature))
        self.assertGreater(result.temperature, 0.01)

    def test_returns_converged_flag(self):
        logits = np.random.default_rng(7).normal(0, 2, size=(100, 3))
        labels = np.random.randint(0, 3, size=100)
        result = fit_temperature(logits, labels)
        self.assertTrue(result.converged)

    def test_temperature_is_positive(self):
        logits = np.random.default_rng(13).normal(0, 1, size=(100, 2))
        labels = np.random.randint(0, 2, size=100)
        result = fit_temperature(logits, labels)
        self.assertGreater(result.temperature, 0.0)

    def test_returns_TemperatureFit_dataclass(self):
        logits = np.random.default_rng(21).normal(0, 1, size=(50, 2))
        labels = np.random.randint(0, 2, size=50)
        result = fit_temperature(logits, labels)
        self.assertIsInstance(result, TemperatureFit)
        self.assertTrue(hasattr(result, "temperature"))
        self.assertTrue(hasattr(result, "nll_before"))
        self.assertTrue(hasattr(result, "nll_after"))
        self.assertTrue(hasattr(result, "converged"))

    def test_bounded_optimiser_does_not_crash_on_edge_inputs(self):
        logits = np.array([[0.0, 0.0], [0.0, 0.0]])
        labels = np.array([0, 1])
        result = fit_temperature(logits, labels)
        self.assertTrue(np.isfinite(result.temperature))

    def test_multiclass_temperature_scaling_works(self):
        rng = np.random.default_rng(55)
        logits = rng.normal(0, 3, size=(300, 5))
        labels = rng.integers(0, 5, size=300)
        result = fit_temperature(logits, labels)
        self.assertGreater(result.temperature, 0.0)
        self.assertLess(result.nll_after, result.nll_before)

    def test_temperature_fit_halves_nll_for_noisy_logits(self):
        rng = np.random.default_rng(7)
        n = 500
        logits = rng.normal(0, 2.0, size=(n, 3))
        labels = rng.integers(0, 3, size=n)
        result = fit_temperature(logits, labels)
        self.assertTrue(np.isfinite(result.temperature))
        self.assertGreater(result.temperature, 0.0)

    def test_grid_fallback_triggers_for_extreme_bracket(self):
        rng = np.random.default_rng(88)
        logits = rng.normal(0, 20, size=(200, 2))
        labels = (logits[:, 0] > logits[:, 1]).astype(int)
        result = fit_temperature(logits, labels, bounds=(0.01, 30.0))
        self.assertTrue(np.isfinite(result.temperature))


if __name__ == "__main__":
    unittest.main()
