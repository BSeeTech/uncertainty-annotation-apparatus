/**
 * Map a numeric uncertainty score to a UI band.
 *
 * Mirrors `app/scoring.py:score_band` from the FastAPI service.
 * Both paths must agree because the worklist endpoint already returns a
 * `score_band`, but defensive code in the UI re-bands when only a raw
 * score is available (for example, immediately after a re-inference
 * round trip when the worklist hasn't been refetched yet).
 *
 * The thresholds are configurable so the user study can tune them
 * per-dataset without touching code.
 */

import type { InferenceStatus, ScoreBand } from '../types';

export interface BandThresholds {
  /** Score >= this is "medium". */
  medium: number;
  /** Score >= this is "high".  Must be >= medium. */
  high: number;
}

export const DEFAULT_BAND_THRESHOLDS: BandThresholds = {
  medium: 0.15,
  high: 0.35,
};

export function scoreBand(
  score: number | null | undefined,
  t: BandThresholds = DEFAULT_BAND_THRESHOLDS,
): ScoreBand | null {
  if (score == null) return null;
  if (!Number.isFinite(score)) return null;
  if (t.high < t.medium) {
    throw new Error(
      `BandThresholds invalid: high (${t.high}) must be >= medium (${t.medium})`,
    );
  }
  if (score >= t.high) return 'high';
  if (score >= t.medium) return 'medium';
  return 'low';
}

/**
 * CSS class string for a score band, intended for use in Tailwind
 * environments (which OHIF v3 ships with).  Returned as a string so
 * the panel components don't have to import this module just to bind
 * a className.
 */
export function bandTailwindClass(band: ScoreBand | null): string {
  switch (band) {
    case 'high':
      return 'bg-red-500/30 text-red-200 border-red-400/40';
    case 'medium':
      return 'bg-yellow-500/30 text-yellow-200 border-yellow-400/40';
    case 'low':
      return 'bg-emerald-500/30 text-emerald-200 border-emerald-400/40';
    default:
      return 'bg-slate-500/20 text-slate-300 border-slate-400/30';
  }
}

/**
 * CSS class string for an inference-status badge, for cases where the
 * score is 0.000 but the inference did not complete normally.
 */
export function inferenceStatusTailwindClass(
  status: InferenceStatus | null | undefined,
): string {
  switch (status) {
    case 'invalid_input':
      return 'bg-rose-600/40 text-rose-200 border-rose-400/50';
    case 'empty_foreground':
      return 'bg-amber-500/30 text-amber-200 border-amber-400/40';
    case 'error':
      return 'bg-red-600/40 text-red-200 border-red-400/50';
    default:
      return 'bg-slate-500/20 text-slate-300 border-slate-400/30';
  }
}

/**
 * Human-readable label for an inference status, shown as badge text.
 */
export function inferenceStatusLabel(status: InferenceStatus | null | undefined): string {
  switch (status) {
    case 'invalid_input':
      return 'INVALID';
    case 'empty_foreground':
      return 'EMPTY';
    case 'error':
      return 'ERROR';
    default:
      return '';
  }
}

/**
 * Returns true when the inference status indicates a problem rather than
 * normal completed inference.
 */
export function isAbnormalStatus(status: InferenceStatus | null | undefined): boolean {
  return status != null && status !== 'completed';
}
