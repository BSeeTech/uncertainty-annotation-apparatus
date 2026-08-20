import React, { useState } from 'react';
import { useUncertaintyState } from '../hooks/useUncertaintyState';
import type { UncertaintyService } from '../services/UncertaintyService';

export interface PanelSubmissionProps {
  service: UncertaintyService;
}

/**
 * The submission panel is rendered alongside the heatmap controls in
 * the right sidebar.  It exposes three primary actions:
 *
 *   - Accept    — the AI mask is correct as-is (C1/C2 only)
 *   - Submit    — send the reviewer's edited mask
 *   - Reject    — record that no useful annotation is possible
 *
 * Plus a small "last outcome" readout showing how many voxels the
 * reviewer edited.
 */
export const PanelSubmission: React.FC<PanelSubmissionProps> = ({ service }) => {
  const state = useUncertaintyState(service);
  const condition = state.session?.condition;
  const hasCase = state.currentCase != null;
  const isSubmitting = state.submission.isSubmitting;
  const requiresAiMask = condition === 'C1' || condition === 'C2';
  const aiMaskReady = Boolean(state.aiSegmentation.segmentationId);
  const aiMaskBusy = state.aiSegmentation.isLoading;
  const isOpeningCase = Boolean(hasCase && requiresAiMask && !state.currentCase?.inference && aiMaskBusy);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectField, setShowRejectField] = useState(false);

  const accept = (): void => {
    void service.submitAnnotation({ status: 'accepted' }).catch(() => {});
  };
  const submitEdited = (): void => {
    void service.submitAnnotation({ status: 'edited' }).catch(() => {});
  };
  const reject = (): void => {
    void service.submitAnnotation({
      status: 'rejected',
      reason: rejectReason || undefined,
    }).catch(() => {});
    setRejectReason('');
    setShowRejectField(false);
  };

  const baseDisabled = !hasCase || isSubmitting;
  const editDisabled = baseDisabled || (requiresAiMask && !aiMaskReady);
  const rejectDisabled = baseDisabled;
  const acceptDisabled = editDisabled || condition === 'C0' || aiMaskBusy;

  const disabledReason = !state.session
    ? 'No reviewer session is active. Add ?reviewer=R03&condition=C0, C1, or C2 to the URL.'
    : !hasCase
      ? 'No case is open. Select a case from the Uncertainty Worklist, or open the mode with &caseId=... in the URL.'
      : isOpeningCase
        ? 'Opening case and importing the MONAILabel AI mask…'
        : isSubmitting
          ? 'Submission is already in progress.'
          : requiresAiMask && aiMaskBusy
            ? 'MONAILabel AI mask is still importing.'
            : requiresAiMask && !aiMaskReady
              ? (state.aiSegmentation.error ?? 'Waiting for the MONAILabel AI mask before accept/edit submission is enabled.')
              : null;

  const acceptDisabledReason = condition === 'C0'
    ? 'Accept AI mask is intentionally disabled in C0 because C0 is manual-only.'
    : disabledReason;

  const last = state.submission.lastOutcome;

  return (
    <div className="p-3 text-white text-sm border-t border-white/10">
      <div className="font-semibold mb-2">Submission</div>

      {disabledReason && (
        <div className="text-xs text-amber-200/90 mb-3" role="status"
             data-testid="submission-disabled-reason">
          {disabledReason}
        </div>
      )}

      {requiresAiMask && (
        <div className="text-xs opacity-75 mb-3" data-testid="ai-mask-status">
          {aiMaskBusy
            ? 'Importing MONAILabel AI mask…'
            : aiMaskReady
              ? 'MONAILabel AI mask imported and editable.'
              : state.aiSegmentation.error
                ? state.aiSegmentation.error
                : 'Waiting for MONAILabel AI mask.'}
        </div>
      )}

      <div className="space-y-2">
        {/* Accept (only meaningful in C1) */}
        <button
          type="button"
          onClick={accept}
          disabled={acceptDisabled}
          data-testid="submit-accept"
          title={acceptDisabledReason ?? undefined}
          className={[
            'w-full rounded border px-3 py-2 transition',
            acceptDisabled
              ? 'border-white/10 bg-black/30 text-white/40 cursor-not-allowed'
              : 'border-emerald-400/60 bg-emerald-500/20 hover:bg-emerald-500/30',
          ].join(' ')}
        >
          {condition === 'C0'
            ? 'Accept (not available in C0)'
            : aiMaskBusy
              ? 'Importing AI mask…'
              : 'Accept AI mask'}
        </button>

        {/* Submit edited */}
        <button
          type="button"
          onClick={submitEdited}
          disabled={editDisabled}
          data-testid="submit-edited"
          title={editDisabled ? (disabledReason ?? undefined) : undefined}
          className={[
            'w-full rounded border px-3 py-2 transition',
            editDisabled
              ? 'border-white/10 bg-black/30 text-white/40 cursor-not-allowed'
              : 'border-sky-400/60 bg-sky-500/20 hover:bg-sky-500/30',
          ].join(' ')}
        >
          {isSubmitting
            ? 'Submitting…'
            : condition === 'C0'
              ? 'Submit manual annotation'
              : 'Submit edited annotation'}
        </button>

        {/* Reject */}
        {!showRejectField ? (
          <button
            type="button"
            onClick={() => setShowRejectField(true)}
            disabled={rejectDisabled}
            data-testid="submit-reject-toggle"
            title={rejectDisabled ? (disabledReason ?? undefined) : undefined}
            className={[
              'w-full rounded border px-3 py-2 transition',
              rejectDisabled
                ? 'border-white/10 bg-black/30 text-white/40 cursor-not-allowed'
                : 'border-rose-400/40 bg-rose-500/10 hover:bg-rose-500/20',
            ].join(' ')}
          >
            Reject case
          </button>
        ) : (
          <div className="space-y-2">
            <textarea
              data-testid="submit-reject-reason"
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder="Reason for rejection (optional)"
              rows={3}
              className="w-full rounded border border-white/20 bg-black/30 px-2 py-1 text-xs"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={reject}
                disabled={rejectDisabled}
                data-testid="submit-reject-confirm"
                className="flex-1 rounded border border-rose-400/60 bg-rose-500/20 hover:bg-rose-500/30 px-3 py-2"
              >
                Confirm reject
              </button>
              <button
                type="button"
                onClick={() => { setShowRejectField(false); setRejectReason(''); }}
                disabled={isSubmitting}
                className="flex-1 rounded border border-white/20 bg-black/30 hover:bg-black/40 px-3 py-2"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Error / last outcome */}
      {state.submission.error && (
        <div className="text-xs text-rose-300 mt-3" role="alert"
             data-testid="submit-error">
          {state.submission.error}
        </div>
      )}

      {last && (
        <div className="border-t border-white/10 mt-3 pt-3 text-xs"
             data-testid="submit-last-outcome">
          <div className="font-semibold opacity-80 mb-1">Submitted</div>
          <Row label="Voxels edited" value={String(last.edit_voxel_count)} />
          {condition !== 'C0' && (
            <Row
              label="% of AI foreground"
              value={`${(last.edit_fraction_of_ai_foreground * 100).toFixed(1)}%`}
            />
          )}
          <div className="opacity-60 mt-1">
            {new Date(last.submitted_at).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex justify-between font-mono">
    <span className="font-sans opacity-80">{label}</span>
    <span>{value}</span>
  </div>
);
