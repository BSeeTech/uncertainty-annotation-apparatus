/**
 * Color and opacity transfer functions for the voxel-level uncertainty
 * heatmap.
 *
 * Design rationale (LR §2.6.2):
 *
 * - Use a perceptually uniform sequential colormap.  Magma is preferred
 *   over rainbow because rainbow introduces non-monotonic perceptual
 *   bands that can fabricate structure where there is none.
 * - Suppress near-zero entropy so that "clean" predictions don't
 *   visually compete with anatomy.  This is the threshold knee at 10%
 *   of `maxEntropy`.
 * - Cap the upper opacity at the user's chosen value (default 0.6) so
 *   the underlying image remains visible even at peak uncertainty.
 *
 * The functions return plain data objects.  The caller is responsible
 * for materialising them as `vtkColorTransferFunction` /
 * `vtkPiecewiseFunction` instances — that step lives in
 * `HeatmapRenderer` so the transfer-function math here remains
 * unit-testable without VTK.
 */

import { DEFAULT_MAX_ENTROPY_BINARY } from '../types';

/**
 * Perceptual opacity power-curve exponent.
 *
 * The user-facing opacity slider is 0–1 linear, but human perception of
 * opacity-overlaid anatomy is non-linear.  Applying the power transforms
 * the raw slider value into a perceptual value:
 *
 *   slider 0%   → actual 0%   (hard lower bound)
 *   slider 95%  → actual ~49% (0.95¹⁴ ≈ 0.488)
 *   slider 100% → actual 100% (hard upper bound)
 *
 * This gives the user finer control in the perceptually-sensitive mid-to-
 * high range while keeping the 0→0 and 1→1 endpoints as hard boundaries.
 */
export const OPACITY_PERCEPTUAL_POWER = 14;

export interface RgbStop {
  /** Entropy value in nats. */
  x: number;
  r: number;   // 0..1
  g: number;   // 0..1
  b: number;   // 0..1
}

export interface OpacityStop {
  /** Entropy value in nats. */
  x: number;
  /** Opacity in 0..1. */
  alpha: number;
}

export interface TransferFunctions {
  color: RgbStop[];
  opacity: OpacityStop[];
  /** Echo of the inputs that produced these functions, for debugging. */
  meta: { maxEntropy: number; baseOpacity: number };
}

/**
 * Five-stop magma-style palette: black → deep purple → magenta →
 * orange → cream.  Values picked from the matplotlib `magma` colormap
 * at the 0.0, 0.25, 0.5, 0.75, 1.0 control points and normalised to
 * 0..1 floats.
 */
const MAGMA_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0.001, 0.000, 0.014],   // 0.00 — near-black
  [0.196, 0.054, 0.392],   // 0.25 — deep purple
  [0.560, 0.110, 0.470],   // 0.50 — magenta
  [0.952, 0.498, 0.196],   // 0.75 — orange
  [0.988, 0.992, 0.749],   // 1.00 — cream
];

/**
 * Build a colormap and an opacity ramp suitable for rendering a
 * predictive-entropy volume.
 *
 * @param opts.maxEntropy   ln(K) for K classes; default ln(2).
 * @param opts.baseOpacity  Top-of-ramp opacity in [0, 1]; default 0.6.
 *                          Lower values keep the heatmap more
 *                          transparent over anatomy.
 * @param opts.suppressBelow Fraction of max below which the heatmap is
 *                          rendered fully transparent.  Default 0.1
 *                          (i.e. the bottom 10% of the entropy range
 *                          is suppressed; "clean" voxels stay invisible).
 */
export function buildTransferFunctions(opts: {
  maxEntropy?: number;
  baseOpacity?: number;
  suppressBelow?: number;
} = {}): TransferFunctions {
  const maxEntropy = opts.maxEntropy ?? DEFAULT_MAX_ENTROPY_BINARY;
  const baseOpacity = clamp01(opts.baseOpacity ?? 0.6);
  const suppressBelow = clamp01(opts.suppressBelow ?? 0.1);

  if (maxEntropy <= 0) {
    throw new Error(`maxEntropy must be > 0, got ${maxEntropy}`);
  }

  const color: RgbStop[] = MAGMA_STOPS.map(([r, g, b], i) => ({
    x: (i / (MAGMA_STOPS.length - 1)) * maxEntropy,
    r, g, b,
  }));

  // Opacity ramp - step function:
  //   x = 0 ... knee -> 0          (suppressed - clean voxels invisible)
  //   x = knee+1e-8 ... maxEntropy -> baseOpacity  (constant, zero-width step)
  const knee = suppressBelow * maxEntropy;
  // Zero-width step: just past the knee, jump straight to baseOpacity
  const opacity: OpacityStop[] = [
    { x: 0,              alpha: 0 },
    { x: knee,           alpha: 0 },
    { x: knee + 1e-8,    alpha: baseOpacity },
    { x: maxEntropy,     alpha: baseOpacity },
  ];

  return {
    color,
    opacity,
    meta: { maxEntropy, baseOpacity },
  };
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
