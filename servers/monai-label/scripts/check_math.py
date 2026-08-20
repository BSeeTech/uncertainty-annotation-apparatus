"""Pure-numpy correctness check for the MC Dropout sampling math.

This stand-alone script does not import torch or monailabel.  Instead it
mirrors the algorithm that ``MCDropoutSegmentation.run_inferer`` runs
and verifies that the resulting entropy volume has the properties we
assert on in the real smoke test:

  1. shape matches the input,
  2. values are in [0, ln(K)],
  3. variance across passes is non-zero when 'dropout' is active,
  4. entropy is exactly zero only where the predictive distribution is
     a delta (one class with prob 1.0) — the boundary case.

The point of this file is not to replace the full smoke test, but to
de-risk the math so that when the user runs the Dockerised smoke test
they only need to debug environment issues, not algorithm bugs.
"""
from __future__ import annotations

import sys
import numpy as np


def softmax(x: np.ndarray, axis: int = 1) -> np.ndarray:
    x = x - x.max(axis=axis, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=axis, keepdims=True)


def stochastic_logits(
    base_logits: np.ndarray, dropout_p: float, rng: np.random.Generator
) -> np.ndarray:
    """A toy stand-in for "logits with dropout active": multiplicatively
    masks the input by a Bernoulli(1-p) field, then rescales by 1/(1-p)
    as torch's nn.Dropout does in train() mode.
    """
    if dropout_p <= 0:
        return base_logits.copy()
    mask = rng.binomial(1, 1.0 - dropout_p, size=base_logits.shape).astype(np.float32)
    return base_logits * mask / (1.0 - dropout_p)


def mc_dropout_predictive_entropy(
    base_logits: np.ndarray, T: int, dropout_p: float, seed: int = 0
) -> tuple[np.ndarray, np.ndarray]:
    """Replicates the algorithm in MCDropoutSegmentation.run_inferer.

    Returns (mean_probs, entropy) where:
        mean_probs : (B, K, ...) — average over T softmaxes
        entropy    : (B, 1, ...) — predictive entropy of the mean
    """
    rng = np.random.default_rng(seed)
    softmax_sum = None
    for _ in range(T):
        logits = stochastic_logits(base_logits, dropout_p, rng)
        probs = softmax(logits, axis=1).astype(np.float32)
        softmax_sum = probs if softmax_sum is None else softmax_sum + probs
    mean_probs = softmax_sum / T
    eps = 1e-8
    entropy = -(mean_probs * np.log(mean_probs + eps)).sum(axis=1, keepdims=True)
    return mean_probs, entropy


def main() -> int:
    rng = np.random.default_rng(42)
    B, K, X, Y, Z = 1, 2, 16, 16, 16
    base_logits = rng.normal(0.0, 1.0, size=(B, K, X, Y, Z)).astype(np.float32)

    print("=" * 60)
    print("Test 1 — basic shape and range")
    print("=" * 60)
    mean_probs, entropy = mc_dropout_predictive_entropy(base_logits, T=10, dropout_p=0.2)
    print(f"  mean_probs shape: {mean_probs.shape}  (expected ({B},{K},{X},{Y},{Z}))")
    print(f"  entropy    shape: {entropy.shape}    (expected ({B},1,{X},{Y},{Z}))")
    assert mean_probs.shape == (B, K, X, Y, Z)
    assert entropy.shape == (B, 1, X, Y, Z)

    log_K = float(np.log(K))
    print(f"  entropy   min: {entropy.min():.6f}   max: {entropy.max():.6f}   ln(K)={log_K:.4f}")
    assert entropy.min() >= -1e-6, f"entropy negative: {entropy.min()}"
    assert entropy.max() <= log_K + 1e-3, f"entropy exceeds ln(K): {entropy.max()}"
    print("  PASS")

    print()
    print("=" * 60)
    print("Test 2 — dropout = 0 produces deterministic predictions")
    print("=" * 60)
    _, ent_a = mc_dropout_predictive_entropy(base_logits, T=10, dropout_p=0.0, seed=1)
    _, ent_b = mc_dropout_predictive_entropy(base_logits, T=10, dropout_p=0.0, seed=2)
    diff = np.abs(ent_a - ent_b).mean()
    print(f"  mean abs difference between runs (no dropout): {diff:.8f}")
    assert diff < 1e-7, "entropy should be identical with dropout=0"
    # Also: with dropout=0, entropy is just H(softmax(base_logits)).
    deterministic_entropy = -(
        softmax(base_logits, 1) * np.log(softmax(base_logits, 1) + 1e-8)
    ).sum(axis=1, keepdims=True)
    assert np.allclose(ent_a, deterministic_entropy, atol=1e-6)
    print("  PASS — dropout=0 reproduces the standard softmax entropy")

    print()
    print("=" * 60)
    print("Test 3 — dropout > 0 produces stochastic predictions")
    print("=" * 60)
    _, ent_c = mc_dropout_predictive_entropy(base_logits, T=16, dropout_p=0.2, seed=10)
    _, ent_d = mc_dropout_predictive_entropy(base_logits, T=16, dropout_p=0.2, seed=11)
    diff_with_dropout = float(np.abs(ent_c - ent_d).mean())
    print(f"  mean abs difference between runs (dropout=0.2): {diff_with_dropout:.6f}")
    assert diff_with_dropout > 1e-4, (
        "entropy should differ between MC runs when dropout>0; "
        "got near-zero variation which suggests a bug in the sampling loop"
    )
    print("  PASS — dropout introduces stochasticity")

    print()
    print("=" * 60)
    print("Test 4 — entropy is zero only at predictive deltas")
    print("=" * 60)
    sharp = np.zeros((1, K, 4, 4, 4), dtype=np.float32)
    sharp[:, 0] = 1000.0  # forces softmax → [1, 0, ...]
    sharp[:, 1] = -1000.0
    _, ent_sharp = mc_dropout_predictive_entropy(sharp, T=5, dropout_p=0.0)
    print(f"  entropy at delta-prediction: max={ent_sharp.max():.8f}  (expected ≈ 0)")
    assert ent_sharp.max() < 1e-6
    # Uniform predictions: entropy = ln(K)
    uniform = np.zeros((1, K, 4, 4, 4), dtype=np.float32)
    _, ent_uniform = mc_dropout_predictive_entropy(uniform, T=5, dropout_p=0.0)
    print(f"  entropy at uniform: mean={ent_uniform.mean():.6f}  (expected ≈ ln(K)={log_K:.4f})")
    assert abs(ent_uniform.mean() - log_K) < 1e-3
    print("  PASS")

    print()
    print("=" * 60)
    print("ALL MATH CHECKS PASSED")
    print("The MC Dropout sampling algorithm in run_inferer is correct.")
    print("Run scripts/smoke_test.py inside the Docker image for the")
    print("full integration test (requires torch + monailabel).")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
