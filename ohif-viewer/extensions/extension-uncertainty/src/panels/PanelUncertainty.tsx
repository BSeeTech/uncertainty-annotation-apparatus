import React from 'react';
import { useUncertaintyState } from '../hooks/useUncertaintyState';
import { inferenceStatusLabel, isAbnormalStatus } from '../utils/scoreBand';
import type { UncertaintyService } from '../services/UncertaintyService';

export interface PanelUncertaintyProps {
  service: UncertaintyService;
}

/**
 * Reviewer-facing controls for the uncertainty heatmap overlay.
 *
 * The panel is rendered in all conditions for layout symmetry but its
 * controls are gated:
 *
 *   - C0 / C1: controls are disabled and a short note explains that
 *              uncertainty information is not available in this
 *              condition.  Showing a disabled panel rather than
 *              hiding it entirely keeps the side-by-side layout
 *              consistent across conditions, which matters for the
 *              user-study photographs.
 *   - C2:      controls are live.
 */
export const PanelUncertainty: React.FC<PanelUncertaintyProps> = ({ service }) => {
  const state = useUncertaintyState(service);
  const hasHeatmap = state.session?.condition === 'C2' || state.session?.condition === 'C3' || state.session?.condition === 'C5';
  const isC2 = state.session?.condition === 'C2';
  const isWaitingForInference = Boolean(hasHeatmap && state.currentCase && !state.currentCase.inference);
  const heatmapLoading = Boolean(hasHeatmap && state.heatmap.isLoading);
  const heatmapError = hasHeatmap ? state.heatmap.error : null;
  const openError = hasHeatmap ? state.aiSegmentation.error : null;
  const disabled = !hasHeatmap || !state.currentCase || isWaitingForInference || heatmapLoading || Boolean(heatmapError);
  const disabledReason = !state.session
    ? 'No reviewer session is active. Add ?reviewer=R03&condition=C2 to the URL.'
    : !hasHeatmap
      ? 'Uncertainty controls are intentionally disabled in C0/C1/C4.'
      : !state.currentCase
        ? 'No case is open. Select a case from the Uncertainty Worklist, or open the mode with &caseId=... in the URL.'
        : heatmapError
          ? heatmapError
          : openError && isWaitingForInference
              ? openError
              : isWaitingForInference || heatmapLoading
                ? 'Opening case and loading the uncertainty map…'
                : null;

  const score = state.currentCase?.inference?.score ?? null;
  const p95 = state.currentCase?.inference?.score_p95 ?? null;
  const fracAbove = state.currentCase?.inference?.score_fraction_above ?? null;

  const onToggle = (): void => service.toggleHeatmap();
  const onOpacity = (e: React.ChangeEvent<HTMLInputElement>): void => {
    service.setHeatmapOpacity(parseFloat(e.target.value));
  };

  return (
    <div className="p-3 text-white text-sm">
      <div className="font-semibold mb-2">Uncertainty</div>

      {disabledReason && (
        <div className="text-xs text-amber-200/90 mb-3" role="status"
             data-testid="uncertainty-disabled-reason">
          {disabledReason}
        </div>
      )}

      <div className="space-y-3">
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          data-testid="heatmap-toggle"
          title={disabled ? (disabledReason ?? undefined) : undefined}
          className={[
            'w-full rounded border px-3 py-2 text-sm transition',
            disabled
              ? 'border-white/10 bg-black/30 text-white/40 cursor-not-allowed'
              : state.heatmap.visible
                ? 'border-sky-400/60 bg-sky-500/20 hover:bg-sky-500/30'
                : 'border-white/20 bg-black/40 hover:bg-black/30',
          ].join(' ')}
          aria-pressed={state.heatmap.visible}
        >
          {state.heatmap.visible ? 'Heatmap: ON' : 'Heatmap: OFF'}
        </button>

        <div>
          <label className="block text-xs opacity-70 mb-1" htmlFor="opacity-slider">
            Opacity: {Math.round(state.heatmap.opacity * 100)}%
          </label>
          <input
            id="opacity-slider"
            data-testid="heatmap-opacity"
            title={disabled ? (disabledReason ?? undefined) : undefined}
            type="range"
            min={0} max={1} step={0.05}
            value={state.heatmap.opacity}
            onChange={onOpacity}
            disabled={disabled}
            className="w-full"
          />
          <div className="mt-1.5 grid grid-cols-3 gap-1" aria-label="Heatmap opacity presets">
            {[0, 0.5, 1].map(value => (
              <button
                key={value}
                type="button"
                data-testid={`heatmap-opacity-${Math.round(value * 100)}`}
                disabled={disabled}
                onClick={() => service.setHeatmapOpacity(value)}
                className="rounded border border-white/20 px-1 py-1 text-xs hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {Math.round(value * 100)}%
              </button>
            ))}
          </div>
        </div>

        {/* Inference-status warning: show for any condition with heatmap */}
        {hasHeatmap && state.currentCase?.inference && isAbnormalStatus(state.currentCase.inference.inference_status) && (
          <div className="border-t border-white/10 pt-3 space-y-1.5 text-xs">
            <div className="font-semibold opacity-80">Case score</div>
            <div
              className="bg-amber-500/20 border border-amber-400/30 rounded px-2 py-1.5 text-amber-200"
              role="status"
              data-testid="inference-status-warning"
            >
              <span className="font-semibold">
                {inferenceStatusLabel(state.currentCase.inference.inference_status)}
              </span>
              <span className="ml-1 opacity-80">
                {state.currentCase.inference.inference_status === 'empty_foreground'
                  ? '— The model produced an empty segmentation mask. The DICOM image may be distorted or contain no recognizable anatomy.'
                  : state.currentCase.inference.inference_status === 'invalid_input'
                    ? '— The image data appears corrupted (NaN or invalid values). The uncertainty score is not meaningful.'
                    : state.currentCase.inference.inference_status === 'error'
                      ? '— An error occurred during scoring. Check server logs for details.'
                      : ''}
              </span>
            </div>
            <div className="opacity-50 mt-1.5" data-testid="model-version">
              {state.currentCase.inference.checkpoint_version}
              &nbsp;·&nbsp;T={state.currentCase.inference.num_samples}
            </div>
          </div>
        )}

        {/* Score breakdown: only for C2 (real entropy) */}
        {isC2 && state.currentCase?.inference && !isAbnormalStatus(state.currentCase.inference.inference_status) && (
          <div className="border-t border-white/10 pt-3 space-y-1.5 text-xs">
            <div className="font-semibold opacity-80">Case score</div>
            <ScoreRow label="Mean foreground" value={score} digits={3} />
            <ScoreRow label="95th percentile" value={p95} digits={3} />
            <ScoreRow
              label={`Fraction > ${state.currentCase.inference.threshold.toFixed(2)}`}
              value={fracAbove}
              percent
            />
            <div className="opacity-50 mt-1.5" data-testid="model-version">
              {state.currentCase.inference.checkpoint_version}
              &nbsp;·&nbsp;T={state.currentCase.inference.num_samples}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const ScoreRow: React.FC<{
  label: string;
  value: number | null;
  digits?: number;
  percent?: boolean;
}> = ({ label, value, digits = 3, percent }) => (
  <div className="flex justify-between font-mono">
    <span className="font-sans opacity-80">{label}</span>
    <span>
      {value == null
        ? '—'
        : percent
          ? `${(value * 100).toFixed(1)}%`
          : value.toFixed(digits)}
    </span>
  </div>
);
