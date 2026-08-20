import React, { useEffect } from 'react';
import { bandTailwindClass, inferenceStatusTailwindClass, inferenceStatusLabel, isAbnormalStatus } from '../utils/scoreBand';
import type { InferenceStatus } from '../types';
import { useUncertaintyState } from '../hooks/useUncertaintyState';
import type { UncertaintyService } from '../services/UncertaintyService';
import type { WorklistPolicy } from '../types';
import { getCaseIdFromUrl, updateCaseIdInUrl } from '../utils/caseUrl';

export interface PanelWorklistProps {
  service: UncertaintyService;
  /**
   * Called when the reviewer clicks a worklist row.  The OHIF mode
   * provides this so the row click can navigate to the case in the
   * viewer (which involves loading the DICOM series, which only the
   * mode knows how to do).
   */
  onOpenCase: (caseId: string) => void | Promise<void>;
  /**
   * The condition controls whether the score column is even visible.
   * In C0 / C1 the reviewer must not see uncertainty information; the
   * worklist still works (FIFO order) but score and band are hidden.
   *
   * Defaults to reading from the service's session — only override in
   * tests or for manual demos.
   */
  forceCondition?: 'C0' | 'C1' | 'C2';
}

const POLICY_LABELS: Record<WorklistPolicy, string> = {
  high_first: 'Highest uncertainty first',
  low_first:  'Lowest uncertainty first',
  fifo:       'Arrival order',
  default:    'Randomised order',
};

export const PanelWorklist: React.FC<PanelWorklistProps> = ({
  service,
  onOpenCase,
  forceCondition,
}) => {
  const state = useUncertaintyState(service);
  const condition = forceCondition ?? state.session?.condition;
  const showScore = condition === 'C2' || condition === 'C3' || condition === 'C4';
  // C0/C1/C5 use the default-order worklist (no score display, no policy
  // picker); showScore is already false for exactly those conditions, so
  // the picker below is correctly hidden without a separate flag.

  // First load with auto-retry on failure
  useEffect(() => {
    let cancelled = false;
    const load = (attempt: number) => {
      void service.refreshWorklist().catch(() => {
        if (!cancelled && attempt < 2) {
          // Retry once after a short delay in case the server
          // was momentarily unreachable on the first attempt.
          setTimeout(() => load(attempt + 1), 2000);
        }
      });
    };
    load(0);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  // If the mode was opened directly with &caseId=... and the mode-level
  // command has not fired yet, still mark the case as selected so the
  // side panels do not stay in the misleading "No case is open" state.
  useEffect(() => {
    if (state.currentCase) return;
    const caseId = getCaseIdFromUrl();
    if (caseId) {
      service.selectCase({ caseId });
    }
  }, [service, state.currentCase]);

  const onPolicyChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    service.setWorklistPolicy(e.target.value as WorklistPolicy);
  };

  const openCase = (caseId: string): void => {
    // Immediate local state + canonical URL update. The OHIF command still
    // performs the heavy work: DICOM retrieve, MONAILabel inference/mask import,
    // and C2 heatmap attachment. This tiny pre-selection removes the dead
    // "No case is open" state even if those heavier async steps are slow.
    updateCaseIdInUrl(caseId);
    service.selectCase({ caseId });
    const result = onOpenCase(caseId);
    if (result && typeof result.catch === 'function') {
      void result.catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        service.markCaseOpenFailed?.({ caseId, error: message });
      });
    }
  };

  return (
    <div className="p-3 text-white text-sm h-full flex flex-col">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="font-semibold">Worklist</span>
        <div className="flex items-center gap-1">
          {/* Policy picker: hidden in C0/C1 to enforce FIFO in those conditions. */}
          {showScore && (
            <select
              value={state.worklist.policy}
              onChange={onPolicyChange}
              className="bg-black/40 border border-white/20 rounded px-2 py-1"
              data-testid="worklist-policy-select"
            >
              {(Object.keys(POLICY_LABELS) as WorklistPolicy[]).map(p => (
                <option key={p} value={p}>{POLICY_LABELS[p]}</option>
              ))}
            </select>
          )}
          {/* Refresh button always visible so the reviewer can retry
              after a network failure without relying on the hotkey. */}
          <button
            type="button"
            onClick={() => service.refreshWorklist().catch(() => undefined)}
            disabled={state.worklist.isLoading}
            title="Refresh worklist"
            className="text-xs border border-white/20 rounded px-1.5 py-1 hover:bg-white/10 disabled:opacity-40"
            data-testid="worklist-refresh-btn"
          >
            ⟳
          </button>
        </div>
      </div>

      {state.worklist.isLoading && (
        <div className="text-xs opacity-70">Loading…</div>
      )}
      {state.worklist.error && (
        <div className="text-xs text-red-300" role="alert">
          {state.worklist.error}
        </div>
      )}

      <ul className="space-y-1 overflow-y-auto flex-1" data-testid="worklist-items">
        {state.worklist.items.map(it => {
          const isCurrent = state.currentCase?.caseId === it.case_id;
          return (
            <li
              key={it.case_id}
              data-testid={`worklist-item-${it.case_id}`}
              className={[
                'cursor-pointer rounded border p-2 hover:bg-white/5 transition',
                isCurrent ? 'border-sky-400/60 bg-sky-500/10' : 'border-white/10',
              ].join(' ')}
              onClick={() => openCase(it.case_id)}
            >
              <div className="flex justify-between items-center gap-2">
                <span className="font-mono truncate" title={it.case_id}>
                  {it.case_id}
                </span>
                {showScore && (
                  <ScoreBadge band={it.score_band} score={it.score} inferenceStatus={it.inference_status} />
                )}
              </div>
              <div className="text-xs opacity-70 mt-0.5">{it.status}</div>
            </li>
          );
        })}
        {!state.worklist.isLoading && state.worklist.items.length === 0 && (
          <li className="text-xs opacity-50 italic" data-testid="worklist-empty">
            No cases ready for review.
          </li>
        )}
      </ul>
    </div>
  );
};

const ScoreBadge: React.FC<{ band: string | null; score: number | null; inferenceStatus?: InferenceStatus | null }> = ({ band, score, inferenceStatus }) => {
  if (score == null) return <span className="text-xs opacity-50">—</span>;
  if (isAbnormalStatus(inferenceStatus)) {
    const label = inferenceStatusLabel(inferenceStatus);
    return (
      <span
        className={`text-xs rounded border px-1.5 py-0.5 whitespace-nowrap ${inferenceStatusTailwindClass(inferenceStatus)}`}
        title={`Inference status: ${inferenceStatus}`}
      >
        {label || score.toFixed(3)}
      </span>
    );
  }
  return (
    <span
      className={`text-xs rounded border px-1.5 py-0.5 whitespace-nowrap ${bandTailwindClass(band as any)}`}
      title={`Mean foreground entropy = ${score.toFixed(3)}`}
    >
      {score.toFixed(3)}
    </span>
  );
};
