/**
 * Shared types and constants for @thesis/extension-uncertainty.
 *
 * Every public surface of this extension references these types so the
 * shape of an uncertainty payload, a worklist entry, or a logged event
 * is defined in exactly one place.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The OHIF extension ID.  Used in module namespacing
 * (e.g. `@thesis/extension-uncertainty.panelModule.worklist`) and in
 * the manifest.  Must match `package.json#name`.
 */
export const EXTENSION_ID = '@thesis/extension-uncertainty';

// ---------------------------------------------------------------------------
// Evaluation conditions
// ---------------------------------------------------------------------------

/**
 * The six evaluation conditions.
 *
 * - C0 — manual baseline: no AI, no uncertainty
 * - C1 — AI-assisted: AI pre-annotation, no uncertainty visualisation
 * - C2 — uncertainty-guided: AI pre-annotation + heatmap + prioritised worklist
 * - C3 — saliency-placebo: AI pre-annotation + Sobel edge overlay (same UI as C2,
 *       but the "uncertainty" map is edge magnitude — controls for boundary salience
 *       and demand characteristics)
 * - C4 — worklist-only: AI pre-annotation + prioritised worklist, NO heatmap
 *       (isolates the effect of reordering from the effect of the heatmap)
 * - C5 — heatmap-only: AI pre-annotation + heatmap, DEFAULT-ORDER worklist
 *       (isolates the effect of the heatmap from the effect of reordering)
 */
export type Condition = 'C0' | 'C1' | 'C2' | 'C3' | 'C4' | 'C5';

export interface SessionContext {
  reviewerId: string;
  condition: Condition;
}

// ---------------------------------------------------------------------------
// Inference / scoring
// ---------------------------------------------------------------------------

/**
 * Mirrors the FastAPI `InferenceResult` Pydantic schema in
 * `uncertainty_service/app/schemas.py`.  A breaking change to one
 * requires a coordinated change to the other.
 */
export interface InferenceResult {
  case_id: string;
  segmentation_url: string;
  uncertainty_url: string | null;
  model_version: string;
  checkpoint_version: string;
  checkpoint_sha256: string;
  num_samples: number;
  dropout_probability: number;
  score: number;                  // mean foreground entropy — primary
  score_p95: number;
  score_fraction_above: number;
  score_mean_all: number;
  threshold: number;
  band: ScoreBand | null;
  inference_status: InferenceStatus;
  metrics_version: string;
  artifact_generation: string;
  result_url: string;
  cache_hit: boolean;
}

export type ScoreBand = 'low' | 'medium' | 'high';

/**
 * Inference status — more granular than just the numeric band.
 * Mirrors STATUS_* constants in uncertainty_service/app/scoring.py.
 *
 *   "completed"        → normal, foreground voxels found, score is meaningful
 *   "empty_foreground" → mask is all background (no segmentation produced)
 *   "invalid_input"    → NIfTI data looks corrupted (NaN, all-zero, etc.)
 *   "error"            → I/O or parsing failure
 */
export type InferenceStatus = 'completed' | 'empty_foreground' | 'invalid_input' | 'error';

export interface WorklistEntry {
  case_id: string;
  patient_id: string | null;
  study_uid: string;
  series_uid: string;
  score: number | null;
  score_band: ScoreBand | null;
  inference_status: InferenceStatus | null;
  status: string;
}

export type WorklistPolicy = 'high_first' | 'low_first' | 'fifo' | 'default';

// ---------------------------------------------------------------------------
// Event logging
// ---------------------------------------------------------------------------

export type EventType =
  | 'case_open'
  | 'case_close'
  | 'slice_change'
  | 'viewport_change'
  | 'heatmap_toggle'
  | 'opacity_change'
  | 'accept'
  | 'reject'
  | 'edit_start'
  | 'edit_end'
  | 'snapshot'
  | 'submit'
  | 'escalate'
  | 'structure_focus';

export interface EventPayload {
  case_id: string;
  reviewer_id: string;
  condition: Condition;
  event_type: EventType;
  payload?: Record<string, unknown> | null;
  client_ts?: string;
}

// ---------------------------------------------------------------------------
// Heatmap rendering configuration
// ---------------------------------------------------------------------------

/**
 * Predictive entropy is in nats and bounded by ln(K) where K is the
 * number of output classes.  For binary segmentation this is ln(2) ≈ 0.6931.
 * For multi-class problems pass the actual ln(K) at runtime.
 */
export const DEFAULT_MAX_ENTROPY_BINARY = Math.log(2);

export interface HeatmapConfig {
  /** Upper bound of the colormap range, in nats.  Pass ln(K) for K classes. */
  maxEntropy: number;
  /**
   * Overall opacity multiplier in [0, 1].
   * Stored as the RAW slider value — the renderer applies a power-curve
   * transform (`^ OPACITY_PERCEPTUAL_POWER`) so the perceptual opacity
   * is lower in the mid-range while keeping 0→0 and 1→1 as hard boundaries.
   */
  opacity: number;
  /** Whether the overlay actor is currently rendered. */
  visible: boolean;
  /** True while the C2 entropy volume is being fetched and attached. */
  isLoading?: boolean;
  /** Last heatmap load failure, shown in the C2 panel instead of an endless spinner. */
  error?: string | null;
}

export const DEFAULT_HEATMAP_CONFIG: HeatmapConfig = {
  maxEntropy: DEFAULT_MAX_ENTROPY_BINARY,
  opacity: 0.964,  // Raw slider value; 0.964¹⁴ ≈ 0.6 perceptual opacity
  visible: false,
  isLoading: false,
  error: null,
};
