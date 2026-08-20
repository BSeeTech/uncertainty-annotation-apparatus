"""Temperature scaling for probability calibration.

Implements temperature scaling (Guo et al., 2017) using bounded optimisation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.optimize import minimize_scalar


@dataclass
class TemperatureFit:
    """Result of fitting a scalar temperature to logits."""

    temperature: float
    nll_before: float
    nll_after: float
    converged: bool


def softmax(logits: np.ndarray, axis: int = -1) -> np.ndarray:
    """Numerically stable softmax."""
    shifted = logits - np.max(logits, axis=axis, keepdims=True)
    exp = np.exp(shifted)
    return exp / np.sum(exp, axis=axis, keepdims=True)


def negative_log_likelihood(
    logits: np.ndarray,
    labels: np.ndarray,
    temperature: float,
    eps: float = 1e-12,
) -> float:
    """NLL of softmax(logits / T) w.r.t. one-hot labels."""
    probs = softmax(logits / temperature)
    n = len(labels)
    # Gather probability of the true class
    p_true = probs[np.arange(n), labels]
    p_true = np.clip(p_true, eps, 1.0 - eps)
    return float(-np.mean(np.log(p_true)))


def apply_temperature(logits: np.ndarray, temperature: float) -> np.ndarray:
    """Return softmax(logits / T)."""
    return softmax(logits / temperature)


def fit_temperature(
    logits: np.ndarray,
    labels: np.ndarray,
    temperature_init: float = 1.0,
    bounds: tuple[float, float] = (0.05, 20.0),
) -> TemperatureFit:
    """Fit scalar temperature by minimising NLL over the bounded interval.

    Uses scipy's bounded method (no bracket condition required, unlike Brent).
    A grid-search fallback handles non-finite or out-of-bounds returns.
    """
    nll_before = negative_log_likelihood(logits, labels, temperature_init)

    def _nll(t: float) -> float:
        return negative_log_likelihood(logits, labels, t)

    result = minimize_scalar(_nll, bounds=bounds, method="bounded")

    temperature = result.x
    converged = result.success

    # Grid-search fallback
    if not converged or not (bounds[0] < temperature < bounds[1]):
        grid = np.linspace(bounds[0], bounds[1], 201)
        nlls = np.array([_nll(t) for t in grid])
        idx = np.argmin(nlls)
        temperature = float(grid[idx])
        converged = True

    nll_after = negative_log_likelihood(logits, labels, temperature)
    return TemperatureFit(
        temperature=float(temperature),
        nll_before=nll_before,
        nll_after=nll_after,
        converged=converged,
    )
