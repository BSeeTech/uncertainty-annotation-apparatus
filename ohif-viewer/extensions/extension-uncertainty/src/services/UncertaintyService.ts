/**
 * UncertaintyService
 *
 * The single orchestrator that the panel components and OHIF commands
 * interact with.  It composes:
 *
 *   - WorklistApi        — talks to FastAPI (cases, infer, worklist, events)
 *   - HeatmapRenderer    — owns the Cornerstone3D entropy volume actor
 *   - EventLogger        — buffers and flushes reviewer interactions
 *
 * All cross-cutting concerns — "open this case from the worklist",
 * "toggle the heatmap", "change opacity" — go through here so:
 *
 *   (a) every user action that affects the rendering also produces an
 *       event log entry, with no risk of the two paths drifting; and
 *   (b) the React panels stay thin: they call methods on this service
 *       and listen to its emitted state, rather than wiring directly
 *       into Cornerstone.
 *
 * The service is plain TypeScript with a tiny event-emitter, so it
 * can be unit-tested without React or Cornerstone.
 */

import type {
  Condition,
  HeatmapConfig,
  InferenceResult,
  SessionContext,
  WorklistEntry,
  WorklistPolicy,
} from '../types';
import { DEFAULT_HEATMAP_CONFIG } from '../types';
import { EventLogger, type EventLoggerApiPort } from './EventLogger';
import { HeatmapRenderer } from './HeatmapRenderer';
import {
  SubmissionApi,
  type SubmissionOutcome,
  type SubmissionStatus,
} from './SubmissionApi';
import { WorklistApi } from './WorklistApi';
import { scoreBand } from '../utils/scoreBand';

// ---------------------------------------------------------------------------
// Segmentation export adapter
//
// The reviewer's edited mask lives in Cornerstone3D's segmentation
// state.  Extracting it as a NIfTI Blob is a host-side concern (the
// API is owned by the host Cornerstone3D V2 adapter, same as the
// CornerstoneAdapter.  The mode supplies an implementation; the
// extension only consumes the contract.
// ---------------------------------------------------------------------------

export interface SegmentationExportAdapter {
  /**
   * Export the reviewer's current segmentation for the case as a NIfTI
   * (.nii.gz) Blob.  Returns ``null`` if no segmentation has been
   * created — the service treats this as "the reviewer made no marks",
   * which for an `accepted` submission is fine (the AI mask is still
   * the truth) and for an `edited` submission is an error caught at
   * the service layer.
   */
  exportSegmentationAsNiftiBlob(args: {
    caseId: string;
    referenceVolumeId: string;
  }): Promise<Blob | null>;
}

export interface SegmentationImportResult {
  segmentationId: string;
}

export interface SegmentationImportAdapter {
  /**
   * Import the MONAILabel/FastAPI AI mask into OHIF's editable segmentation
   * state.  C1 and C2 both call this after inference; C0 never does.
   */
  importSegmentation(args: {
    caseId: string;
    segmentationUrl: string;
    referenceVolumeId: string;
    viewportIds: string[];
    label?: string;
  }): Promise<SegmentationImportResult | null>;

  /** Remove a previously imported AI mask when leaving or replacing a case. */
  removeSegmentation?(args: {
    segmentationId: string;
    viewportIds: string[];
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Public state shape
// ---------------------------------------------------------------------------

export interface UncertaintyState {
  /** The currently-open case, if any. */
  currentCase: {
    caseId: string;
    inference: InferenceResult | null;
  } | null;
  /** MONAILabel/AI pre-annotation imported into OHIF segmentation tools. */
  aiSegmentation: {
    isLoading: boolean;
    error: string | null;
    segmentationId: string | null;
  };
  heatmap: HeatmapConfig;
  worklist: {
    items: WorklistEntry[];
    policy: WorklistPolicy;
    isLoading: boolean;
    error: string | null;
  };
  session: SessionContext | null;
  /** Submission state for the current case. */
  submission: {
    isSubmitting: boolean;
    error: string | null;
    /** The most recent successful submission for the current case. */
    lastOutcome: SubmissionOutcome | null;
  };
}

const INITIAL_STATE: UncertaintyState = {
  currentCase: null,
  aiSegmentation: {
    isLoading: false,
    error: null,
    segmentationId: null,
  },
  heatmap: { ...DEFAULT_HEATMAP_CONFIG },
  worklist: {
    items: [],
    policy: 'high_first',
    isLoading: false,
    error: null,
  },
  session: null,
  submission: {
    isSubmitting: false,
    error: null,
    lastOutcome: null,
  },
};

// ---------------------------------------------------------------------------
// Tiny synchronous event emitter
// ---------------------------------------------------------------------------

type Listener = (state: UncertaintyState) => void;

class StateBus {
  private state: UncertaintyState = INITIAL_STATE;
  private listeners = new Set<Listener>();

  get(): UncertaintyState {
    return this.state;
  }

  set(next: UncertaintyState): void {
    this.state = next;
    for (const l of this.listeners) l(this.state);
  }

  patch(patch: Partial<UncertaintyState>): void {
    this.set({ ...this.state, ...patch });
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface WorklistApiPort extends EventLoggerApiPort {
  getWorklist: WorklistApi['getWorklist'];
  runInference: WorklistApi['runInference'];
}

export interface SubmissionApiPort {
  submit: SubmissionApi['submit'];
  updateStatus: SubmissionApi['updateStatus'];
  getAnnotation: SubmissionApi['getAnnotation'];
}

export interface HeatmapRendererPort {
  loadForCase: HeatmapRenderer['loadForCase'];
  unload: HeatmapRenderer['unload'];
  setVisible: HeatmapRenderer['setVisible'];
  setOpacity: HeatmapRenderer['setOpacity'];
  setMaxEntropy: HeatmapRenderer['setMaxEntropy'];
}

export interface UncertaintyServiceOptions {
  api: WorklistApiPort;
  submissionApi: SubmissionApiPort;
  exporter: SegmentationExportAdapter;
  segmentationImporter: SegmentationImportAdapter;
  logger: EventLogger;
  renderer: HeatmapRendererPort;
}

export class UncertaintyService {
  private api: WorklistApiPort;
  private submissionApi: SubmissionApiPort;
  private exporter: SegmentationExportAdapter;
  private segmentationImporter: SegmentationImportAdapter;
  private readonly logger: EventLogger;
  private renderer: HeatmapRendererPort;
  private currentImportedSegmentation: {
    segmentationId: string;
    viewportIds: string[];
  } | null = null;
  private readonly bus = new StateBus();
  /** Reference volume id for the currently open case, captured at openCase
   *  time and reused at submission time so the exporter knows which
   *  Cornerstone3D volume's frame of reference to use. */
  private currentReferenceVolumeId: string | null = null;
  private editStarted = false;

  constructor(opts: UncertaintyServiceOptions) {
    this.api = opts.api;
    this.submissionApi = opts.submissionApi;
    this.exporter = opts.exporter;
    this.segmentationImporter = opts.segmentationImporter;
    this.logger = opts.logger;
    this.renderer = opts.renderer;
  }

  /** Optional callback for opening a case from the worklist panel.
   * The mode sets this up during onModeEnter to call openUncertaintyCase
   * with the proper host services, bypassing the commandsManager.runCommand
   * indirection which may not propagate async command results correctly. */
  openCaseCommand: ((caseId: string) => Promise<void>) | null = null;

  configureRuntimeDependencies(opts: Partial<{
    api: WorklistApiPort;
    submissionApi: SubmissionApiPort;
    exporter: SegmentationExportAdapter;
    segmentationImporter: SegmentationImportAdapter;
    renderer: HeatmapRendererPort;
    openCaseCommand: (caseId: string) => Promise<void>;
  }>): void {
    if (opts.api) {
      this.api = opts.api;
      this.logger.configureApi(opts.api);
    }
    if (opts.submissionApi) this.submissionApi = opts.submissionApi;
    if (opts.exporter) this.exporter = opts.exporter;
    if (opts.segmentationImporter) this.segmentationImporter = opts.segmentationImporter;
    if (opts.renderer) this.renderer = opts.renderer;
    if (opts.openCaseCommand) this.openCaseCommand = opts.openCaseCommand;
  }

  // -------------------------------------------------------------------
  // State access
  // -------------------------------------------------------------------

  getState(): UncertaintyState {
    return this.bus.get();
  }

  subscribe(l: (s: UncertaintyState) => void): () => void {
    return this.bus.subscribe(l);
  }

  // -------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------

  setSession(session: SessionContext): void {
    this.logger.setSession(session);
    // C0/C1 must never inherit uncertainty-prioritised ordering. Keeping the
    // policy condition-scoped is part of the experimental isolation contract,
    // even though the selector and score badges are hidden in those arms.
    const policy: WorklistPolicy = session.condition === 'C2' ? 'high_first' : 'fifo';
    this.bus.patch({
      session,
      worklist: { ...this.bus.get().worklist, policy },
    });
  }

  /**
   * Convenience: reads `?reviewer=...&condition=...` from a query
   * string and applies it.  Returns true if both keys were present.
   *
   * The OHIF mode calls this on entry so the user study can switch
   * conditions by URL alone, without code changes.
   */
  applySessionFromQuery(search: string): boolean {
    const params = new URLSearchParams(search);
    const reviewer = params.get('reviewer');
    const condition = params.get('condition') as Condition | null;
    if (!reviewer || !condition) return false;
    if (!['C0', 'C1', 'C2', 'C3', 'C4', 'C5'].includes(condition)) return false;
    this.setSession({ reviewerId: reviewer, condition });
    return true;
  }

  // -------------------------------------------------------------------
  // Worklist
  // -------------------------------------------------------------------

  async refreshWorklist(policy?: WorklistPolicy): Promise<void> {
    const effectivePolicy = policy ?? this.bus.get().worklist.policy;
    this.bus.patch({
      worklist: {
        ...this.bus.get().worklist,
        policy: effectivePolicy,
        isLoading: true,
        error: null,
      },
    });
    try {
      const items = await this.api.getWorklist({
        policy: effectivePolicy,
        limit: 50,
        reviewerId: this.bus.get().session?.reviewerId,
        condition: this.bus.get().session?.condition,
      });
      // Deduplicate by case_id: keep the first occurrence so the
      // worklist never produces a React "duplicate key" warning.
      const seen = new Set<string>();
      const deduped = items.filter(it => {
        if (seen.has(it.case_id)) return false;
        seen.add(it.case_id);
        return true;
      });
      this.bus.patch({
        worklist: {
          items: deduped,
          policy: effectivePolicy,
          isLoading: false,
          error: null,
        },
      });
    } catch (err) {
      this.bus.patch({
        worklist: {
          ...this.bus.get().worklist,
          isLoading: false,
          error: (err as Error).message,
        },
      });
      throw err;
    }
  }

  setWorklistPolicy(policy: WorklistPolicy): void {
    // Persist intent immediately so the UI reflects it even before the
    // refresh completes.
    this.bus.patch({
      worklist: { ...this.bus.get().worklist, policy },
    });
    void this.refreshWorklist(policy).catch(() => undefined);
  }

  // -------------------------------------------------------------------
  // Per-case lifecycle
  // -------------------------------------------------------------------

  private async unloadImportedSegmentation(): Promise<void> {
    const current = this.currentImportedSegmentation;
    if (!current) return;
    this.currentImportedSegmentation = null;
    try {
      await this.segmentationImporter.removeSegmentation?.({
        segmentationId: current.segmentationId,
        viewportIds: current.viewportIds,
      });
    } finally {
      this.bus.patch({
        aiSegmentation: {
          isLoading: false,
          error: null,
          segmentationId: null,
        },
      });
    }
  }

  private patchWorklistEntry(
    caseId: string,
    patch: Partial<Pick<WorklistEntry, 'score' | 'score_band' | 'inference_status' | 'status'>>,
  ): void {
    const state = this.bus.get();
    const items = state.worklist.items.map(item => (
      item.case_id === caseId || item.study_uid === caseId || item.series_uid === caseId
        ? { ...item, ...patch }
        : item
    ));
    this.bus.patch({
      worklist: {
        ...state.worklist,
        items,
      },
    });
  }


  /**
   * Mark a case as selected before the host has finished loading the DICOM
   * series.  The mode calls this immediately when the reviewer clicks a
   * worklist item so both side panels and the URL stop saying "no case"
   * while OHIF, MONAILabel, and the heatmap renderer are still catching up.
   *
   * The real openManualCase/openCase methods below still own the final state.
   */
  selectCase(args: { caseId: string }): void {
    const condition = this.bus.get().session?.condition;
    const requiresAiMask = condition === 'C1' || condition === 'C2';

    this.logger.setCurrentCase(args.caseId);
    this.editStarted = false;
    this.bus.patch({
      currentCase: { caseId: args.caseId, inference: null },
      aiSegmentation: {
        isLoading: requiresAiMask,
        error: null,
        segmentationId: null,
      },
      heatmap: { ...DEFAULT_HEATMAP_CONFIG, visible: false, isLoading: false, error: null },
      submission: { ...INITIAL_STATE.submission },
    });
    this.patchWorklistEntry(args.caseId, { status: 'in_review' });
  }

  /**
   * Convert an early host-side failure (DICOM load, viewport discovery, volume
   * resolution) into panel-visible state. Without this, a direct Study List
   * launch can leave both right panels frozen in their optimistic "opening"
   * state after the command has already failed in the console.
   */
  markCaseOpenFailed(args: { caseId: string; error: string }): void {
    const condition = this.bus.get().session?.condition;
    const requiresAiMask = condition === 'C1' || condition === 'C2';
    this.bus.patch({
      currentCase: { caseId: args.caseId, inference: null },
      aiSegmentation: {
        isLoading: false,
        error: requiresAiMask ? args.error : null,
        segmentationId: null,
      },
      heatmap: {
        ...this.bus.get().heatmap,
        visible: false,
        isLoading: false,
        error: condition === 'C2' ? args.error : null,
      },
      submission: {
        ...this.bus.get().submission,
        isSubmitting: false,
        error: args.error,
      },
    });
  }

  /**
   * Open a case: log `case_open`, fetch inference results, attach the
   * heatmap for C2 only, and put the service into the "current case"
   * state. C1 runs inference for the MONAILabel AI mask but never loads
   * the entropy overlay; C2 imports that AI mask and adds uncertainty;
   * C0 should use openManualCase instead.
   */
  async openCase(args: {
    caseId: string;
    referenceVolumeId: string;
    viewportIds: string[];
  }): Promise<InferenceResult> {
    const session = this.bus.get().session;
    const requiresAiMask =
      session?.condition === 'C1' || session?.condition === 'C2';
    const requiresHeatmap = session?.condition === 'C2';

    this.logger.setCurrentCase(args.caseId);
    this.editStarted = false;
    this.logger.log('case_open', { caseId: args.caseId });
    this.currentReferenceVolumeId = args.referenceVolumeId;
    await this.unloadImportedSegmentation();
    await this.renderer.unload();

    // Mark current case immediately and keep the AI mask busy flag true for
    // C1 until either import succeeds or a concrete error is available.
    this.bus.patch({
      currentCase: { caseId: args.caseId, inference: null },
      aiSegmentation: {
        isLoading: requiresAiMask,
        error: null,
        segmentationId: null,
      },
      heatmap: { ...DEFAULT_HEATMAP_CONFIG, visible: false, isLoading: false, error: null },
      submission: { ...INITIAL_STATE.submission },
    });

    // Tell the backend the reviewer has started this case.  Failure
    // here is non-fatal — we log it and proceed; the analysis can
    // still derive timing from the events table.
    if (session) {
      void this.submissionApi.updateStatus({
        caseId: args.caseId,
        reviewerId: session.reviewerId,
        condition: session.condition,
        status: 'in_review',
      }).catch(err => {
        // eslint-disable-next-line no-console
        console.warn('[UncertaintyService] updateStatus(in_review) failed:', err);
      });
    }

    let inference: InferenceResult;
    try {
      inference = await this.api.runInference(
        args.caseId,
        session?.condition,
      );
    } catch (err) {
      const msg = `Inference failed: ${(err as Error).message}`;
      this.markCaseOpenFailed({ caseId: args.caseId, error: msg });
      throw new Error(msg);
    }

    // Once inference has returned, stop reporting a generic "opening case"
    // state. Any later MONAILabel import or heatmap failure gets its own
    // panel-visible message instead of leaving currentCase.inference null.
    this.bus.patch({
      currentCase: { caseId: args.caseId, inference },
      heatmap: { ...this.bus.get().heatmap, isLoading: false, error: null },
    });
    this.patchWorklistEntry(args.caseId, {
      score: inference.score,
      score_band: scoreBand(inference.score),
      inference_status: inference.inference_status,
      status: 'in_review',
    });

    if (requiresAiMask && !inference.segmentation_url) {
      const msg = `AI segmentation import failed: inference response for ${args.caseId} ` +
        'did not include segmentation_url.';
      this.bus.patch({
        aiSegmentation: {
          isLoading: false,
          error: msg,
          segmentationId: null,
        },
      });
      throw new Error(msg);
    }

    let importedSegmentationId: string | null = null;
    if (requiresAiMask) {
      this.bus.patch({
        aiSegmentation: {
          isLoading: true,
          error: null,
          segmentationId: null,
        },
      });
      try {
        const imported = await this.segmentationImporter.importSegmentation({
          caseId: args.caseId,
          segmentationUrl: inference.segmentation_url as string,
          referenceVolumeId: args.referenceVolumeId,
          viewportIds: args.viewportIds,
          label: `MONAILabel AI mask · ${args.caseId}`,
        });
        importedSegmentationId = imported?.segmentationId ?? null;
        if (!importedSegmentationId) {
          throw new Error('segmentation importer returned null');
        }
        this.currentImportedSegmentation = {
          segmentationId: importedSegmentationId,
          viewportIds: args.viewportIds,
        };
        this.bus.patch({
          aiSegmentation: {
            isLoading: false,
            error: null,
            segmentationId: importedSegmentationId,
          },
        });
      } catch (err) {
        const msg = `AI segmentation import failed: ${(err as Error).message}`;
        this.bus.patch({
          aiSegmentation: {
            isLoading: false,
            error: msg,
            segmentationId: null,
          },
        });
        throw new Error(msg);
      }
    } else {
      this.bus.patch({
        aiSegmentation: { isLoading: false, error: null, segmentationId: null },
      });
    }

    // The entropy overlay is a C2-only intervention. C1 may receive
    // an inference payload with no uncertainty_url, and that should
    // never attempt renderer attachment. C2, however, requires the map.
    if (requiresHeatmap && !inference.uncertainty_url) {
      const msg = `Uncertainty heatmap load failed: inference response for ${args.caseId} ` +
        'did not include uncertainty_url.';
      this.bus.patch({
        heatmap: { ...this.bus.get().heatmap, visible: false, isLoading: false, error: msg },
      });
      return inference;
    }

    const showHeatmap = Boolean(requiresHeatmap && inference.uncertainty_url);

    if (showHeatmap) {
      this.bus.patch({
        heatmap: { ...this.bus.get().heatmap, visible: false, isLoading: true, error: null },
      });
      try {
        await this.renderer.loadForCase({
          caseId: args.caseId,
          entropyUrl: inference.uncertainty_url as string,
          referenceVolumeId: args.referenceVolumeId,
          viewportIds: args.viewportIds,
          initialConfig: { visible: showHeatmap },
        });
        // Re-inforce visibility after loadForCase to compensate for
        // Cornerstone3D v2 addVolumes only handling visibility === false
        // (it never explicitly sets actors visible).  Without this, the
        // heatmap actor stays in its default visible state in some cases
        // but can be invisible in others (e.g. after viewport transitions
        // during case switching).
        this.renderer.setVisible(true);
      } catch (err) {
        const msg = `Uncertainty heatmap load failed: ${(err as Error).message}`;
        this.bus.patch({
          heatmap: { ...this.bus.get().heatmap, visible: false, isLoading: false, error: msg },
        });
        return inference;
      }
    }

    this.bus.patch({
      currentCase: { caseId: args.caseId, inference },
      heatmap: {
        ...DEFAULT_HEATMAP_CONFIG,
        visible: showHeatmap,
        isLoading: false,
        error: null,
      },
    });

    return inference;
  }

  /**
   * Open a C0/manual-baseline case. The mode has already loaded the
   * image series; no model inference or heatmap renderer work happens.
   */
  async openManualCase(args: {
    caseId: string;
    referenceVolumeId?: string;
  }): Promise<void> {
    const session = this.bus.get().session;
    this.logger.setCurrentCase(args.caseId);
    this.editStarted = false;
    this.logger.log('case_open', { caseId: args.caseId });
    this.currentReferenceVolumeId = args.referenceVolumeId ?? null;
    await this.unloadImportedSegmentation();
    await this.renderer.unload();

    this.bus.patch({
      currentCase: { caseId: args.caseId, inference: null },
      aiSegmentation: {
        isLoading: false,
        error: null,
        segmentationId: null,
      },
      heatmap: { ...DEFAULT_HEATMAP_CONFIG, visible: false },
      submission: { ...INITIAL_STATE.submission },
    });
    this.patchWorklistEntry(args.caseId, { status: 'in_review' });

    if (session) {
      void this.submissionApi.updateStatus({
        caseId: args.caseId,
        reviewerId: session.reviewerId,
        condition: session.condition,
        status: 'in_review',
      }).catch(err => {
        // eslint-disable-next-line no-console
        console.warn('[UncertaintyService] updateStatus(in_review) failed:', err);
      });
    }
  }

  async closeCase(): Promise<void> {
    const cur = this.bus.get().currentCase;
    if (!cur) return;
    this.logger.log('case_close', { caseId: cur.caseId });
    // Start the network flush before asynchronous viewport/volume teardown.
    // OHIF does not await onModeExit, so delaying this until after unload can
    // lose case_close during route or full-page navigation.
    const closeEventFlush = this.logger.flush();
    this.logger.setCurrentCase(null);
    this.currentReferenceVolumeId = null;
    await this.unloadImportedSegmentation();
    await this.renderer.unload();
    this.bus.patch({
      currentCase: null,
      aiSegmentation: {
        isLoading: false,
        error: null,
        segmentationId: null,
      },
      heatmap: { ...DEFAULT_HEATMAP_CONFIG },
      submission: { ...INITIAL_STATE.submission },
    });
    // Force a flush on close so completion timestamps land in the
    // database promptly even if the reviewer is fast.
    try { await closeEventFlush; } catch { /* swallow — retry next tick */ }
  }

  // -------------------------------------------------------------------
  // Heatmap controls
  // -------------------------------------------------------------------

  setHeatmapVisible(visible: boolean): void {
    // C0 / C1 lock the heatmap to hidden — defensive guard so a stray
    // hotkey can't reveal it during the user study.
    const cond = this.bus.get().session?.condition;
    if (cond !== 'C2' && visible) {
      // eslint-disable-next-line no-console
      console.warn(`[UncertaintyService] Refusing to show heatmap in condition ${cond}`);
      return;
    }
    this.renderer.setVisible(visible);
    this.bus.patch({
      heatmap: { ...this.bus.get().heatmap, visible },
    });
    this.logger.log('heatmap_toggle', { visible });
  }

  toggleHeatmap(): void {
    this.setHeatmapVisible(!this.bus.get().heatmap.visible);
  }

  setHeatmapOpacity(opacity: number): void {
    const clamped = Math.max(0, Math.min(1, opacity));
    this.renderer.setOpacity(clamped);
    this.bus.patch({
      heatmap: { ...this.bus.get().heatmap, opacity: clamped },
    });
    this.logger.log('opacity_change', { opacity: clamped });
  }

  /** Bridge host-level Cornerstone events into the study event stream. */
  logViewerEvent(
    eventType: 'slice_change' | 'viewport_change' | 'structure_focus',
    payload?: Record<string, unknown>,
  ): void {
    this.logger.log(eventType, payload ?? null);
  }

  /** Record the first edit and a lightweight state snapshot for each change. */
  recordSegmentationChange(payload?: Record<string, unknown>): void {
    if (!this.editStarted) {
      this.editStarted = true;
      this.logger.log('edit_start', payload ?? null);
    }
    this.logger.log('snapshot', payload ?? null);
  }

  // -------------------------------------------------------------------
  // Reviewer actions — submission flow
  // -------------------------------------------------------------------

  /**
   * Submit the reviewer's final decision for the current case.
   *
   * The flow:
   *   1. Validate that there's a current case + session.
   *   2. For non-rejection statuses, ask the host exporter for the
   *      mask blob.  If none can be produced, fail loudly — the
   *      analysis depends on every accepted/edited submission having
   *      a real mask.
   *   3. Log the matching event ('accept' / 'edit_end' / 'reject' /
   *      'escalate') BEFORE the network call so the timing reflects
   *      reviewer intent rather than network latency.
   *   4. POST to /annotations.
   *   5. Log 'submit' with the diff metrics from the response.
   *   6. Update state and return the outcome.
   */
  async submitAnnotation(args: {
    status: SubmissionStatus;
    /** Optional reviewer-supplied note (e.g. reason for rejection). */
    reason?: string;
  }): Promise<SubmissionOutcome> {
    const cur = this.bus.get().currentCase;
    const session = this.bus.get().session;
    if (!cur) {
      throw new Error('[UncertaintyService] No current case to submit.');
    }
    if (!session) {
      throw new Error(
        '[UncertaintyService] No session set — cannot submit. ' +
        'Set ?reviewer=&condition= in the URL or call setSession.',
      );
    }
    if (args.status === 'in_review') {
      throw new Error(
        "[UncertaintyService] submitAnnotation does not accept status='in_review'; " +
        'use updateStatus or wait for openCase to set it automatically.',
      );
    }

    this.bus.patch({
      submission: {
        ...this.bus.get().submission,
        isSubmitting: true,
        error: null,
      },
    });

    // Log the reviewer-intent event up front so the timestamp captures
    // the moment the decision was made, not when the upload finished.
    const reasonPayload = args.reason ? { reason: args.reason } : undefined;
    if (args.status === 'accepted') {
      this.logger.log('accept', reasonPayload ?? null);
    } else if (args.status === 'edited') {
      this.logger.log('edit_end', reasonPayload ?? null);
    } else if (args.status === 'rejected') {
      this.logger.log('reject', reasonPayload ?? null);
    } else if (args.status === 'escalated') {
      this.logger.log('escalate', reasonPayload ?? null);
    }

    let blob: Blob | undefined;
    if (args.status !== 'rejected') {
      if (!this.currentReferenceVolumeId) {
        // No reference volume means openCase wasn't called or its
        // C0 short-circuit was taken.  C0 still produces a mask (the
        // reviewer's manual annotation), so we ask the exporter
        // anyway with a placeholder reference id; the exporter is
        // expected to handle the missing reference gracefully.
        // eslint-disable-next-line no-console
        console.warn(
          '[UncertaintyService] No reference volume captured for current case; ' +
          'asking exporter without one. C0 paths should still resolve.',
        );
      }
      try {
        blob = await this.exporter.exportSegmentationAsNiftiBlob({
          caseId: cur.caseId,
          referenceVolumeId: this.currentReferenceVolumeId ?? '',
        }) ?? undefined;
      } catch (err) {
        const msg = `Segmentation export failed: ${(err as Error).message}`;
        this.bus.patch({
          submission: {
            ...this.bus.get().submission,
            isSubmitting: false,
            error: msg,
          },
        });
        throw new Error(msg);
      }
      if (!blob) {
        const msg = `Cannot submit status='${args.status}' without a mask. ` +
          'The exporter returned null — has the reviewer drawn anything?';
        this.bus.patch({
          submission: {
            ...this.bus.get().submission,
            isSubmitting: false,
            error: msg,
          },
        });
        throw new Error(msg);
      }
    }

    let outcome: SubmissionOutcome;
    try {
      outcome = await this.submissionApi.submit({
        caseId: cur.caseId,
        reviewerId: session.reviewerId,
        condition: session.condition,
        status: args.status,
        maskBlob: blob,
      });
    } catch (err) {
      const msg = (err as Error).message;
      this.bus.patch({
        submission: {
          ...this.bus.get().submission,
          isSubmitting: false,
          error: msg,
        },
      });
      throw err;
    }

    // 'submit' is the universal terminal event in the event log,
    // independent of which decision was made.  This is what the
    // analysis chapter uses to bound per-case time.
    this.logger.log('submit', {
      status: args.status,
      edit_voxel_count: outcome.edit_voxel_count,
      edit_fraction_of_ai_foreground: outcome.edit_fraction_of_ai_foreground,
    });
    // Push events to the server promptly so the submission timestamp
    // is in the database before the reviewer navigates away.
    try { await this.logger.flush(); } catch { /* retry on next tick */ }

    this.bus.patch({
      submission: {
        isSubmitting: false,
        error: null,
        lastOutcome: outcome,
      },
    });
    return outcome;
  }

  // -------------------------------------------------------------------
  // Convenience wrappers — kept for backward compatibility with code
  // that already calls accept/reject/escalate.  Internally they all
  // route through submitAnnotation now.
  // -------------------------------------------------------------------

  async acceptCurrent(): Promise<SubmissionOutcome | null> {
    if (this.bus.get().session?.condition === 'C0') {
      throw new Error('[UncertaintyService] C0 has no AI mask to accept.');
    }
    return this.submitAnnotation({ status: 'accepted' });
  }

  async rejectCurrent(reason?: string): Promise<SubmissionOutcome | null> {
    return this.submitAnnotation({ status: 'rejected', reason });
  }

  async escalateCurrent(reason?: string): Promise<SubmissionOutcome | null> {
    return this.submitAnnotation({ status: 'escalated', reason });
  }
}
