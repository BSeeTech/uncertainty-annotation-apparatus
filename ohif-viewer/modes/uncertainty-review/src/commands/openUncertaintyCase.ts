/**
 * `openUncertaintyCase` — the host-side command that the worklist
 * panel runs when the reviewer clicks a case.
 *
 * Why this exists in the mode rather than in the extension:
 *
 * "Open this case in the viewer" means three things together:
 *   1. tell the OHIF data source to load the DICOM series for the case,
 *   2. wait for the image volume to be cached and available in
 *      Cornerstone3D so the reference frame of reference is known,
 *   3. tell `UncertaintyService.openCase(...)` to import the AI mask and attach the heatmap.
 *
 * Step 1 and 2 are OHIF-host concerns: they need to know about
 * `displaySetService`, `viewportGridService`, the data source URL
 * scheme, etc.  The extension is meant to be agnostic to those, so
 * the orchestration belongs here.
 *
 * The command is split into a pure "compute the plan" function
 * (`buildOpenPlan`) and an "execute the plan" function (`executeOpen`)
 * so we can unit-test the planning without an OHIF host.  The plan
 * captures the data source, the case-id-to-series-uid mapping, and
 * the viewport IDs to attach the heatmap to.
 */

import type {
  Condition,
  UncertaintyService,
  WorklistEntry,
} from '@thesis/extension-uncertainty';

const INFERENCE_IMPORT_TIMEOUT_MS = 1_800_000;

// ---------------------------------------------------------------------------
// Loose host types — OHIF surface differs slightly per version
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

type ManualOpenUncertaintyService = UncertaintyService & {
  selectCase?(args: { caseId: string }): void;
  markCaseOpenFailed?(args: { caseId: string; error: string }): void;
  openManualCase(args: {
    caseId: string;
    referenceVolumeId?: string;
  }): Promise<void>;
};

export interface OpenCaseHost {
  /** Look up the worklist entry the user clicked, by case id. */
  getWorklistEntry(caseId: string): WorklistEntry | null;
  /** Currently active condition; passed through for plan validation. */
  getCondition(): Condition | null;
  /** OHIF services. */
  servicesManager: {
    services: {
      uncertaintyService: ManualOpenUncertaintyService;
      displaySetService?: AnyService;
      viewportGridService?: AnyService;
      cornerstoneViewportService?: AnyService;
      hangingProtocolService?: AnyService;
    };
  };
  /** Tell OHIF's data source to retrieve the DICOM series for this case. */
  loadStudy(args: {
    studyInstanceUID: string;
    seriesInstanceUID: string;
  }): Promise<void>;
  /** Resolve the Cornerstone volume id for a loaded series. */
  resolveImageVolumeId(seriesInstanceUID: string): Promise<string>;
  /** Resolve the active viewport ids the heatmap should attach to. */
  resolveActiveViewportIds(): string[];
}

// ---------------------------------------------------------------------------
// Pure planning step
// ---------------------------------------------------------------------------

export interface OpenPlan {
  caseId: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  /** Whether to actually run inference for this condition. */
  runInference: boolean;
  /** Whether to import the AI segmentation into active viewports. */
  importAiSegmentation: boolean;
  /** Whether to attach the heatmap volume to viewports. */
  attachHeatmap: boolean;
}

export type OpenPlanError =
  | { kind: 'unknown_case' }
  | { kind: 'no_session' }
  | { kind: 'invalid_condition'; condition: string };

/**
 * Resolve a case id to a concrete plan.  Returns `OpenPlanError` for
 * any reason the open should not proceed.  Pure function — used by
 * tests.
 */
export function buildOpenPlan(args: {
  caseId: string;
  entry: WorklistEntry | null;
  condition: Condition | null;
}): OpenPlan | OpenPlanError {
  if (!args.condition) return { kind: 'no_session' };
  if (!['C0', 'C1', 'C2', 'C3', 'C4', 'C5'].includes(args.condition)) {
    return { kind: 'invalid_condition', condition: args.condition };
  }
  if (!args.entry) return { kind: 'unknown_case' };

  // Inference runs in all conditions except C0.
  // AI mask is imported for C1-C5 (anything with AI pre-annotation).
  // Heatmap is attached for C2 (entropy), C3 (placebo saliency), C5 (entropy, no reorder).
  const runInference = args.condition !== 'C0';
  const importAiSegmentation = args.condition !== 'C0';
  const attachHeatmap = args.condition === 'C2' || args.condition === 'C3' || args.condition === 'C5';

  return {
    caseId: args.caseId,
    studyInstanceUID: args.entry.study_uid,
    seriesInstanceUID: args.entry.series_uid,
    runInference,
    importAiSegmentation,
    attachHeatmap,
  };
}

// ---------------------------------------------------------------------------
// Side-effectful execution
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

async function waitForActiveViewportIds(
  host: OpenCaseHost,
  timeoutMs = 5_000,
  intervalMs = 200,
): Promise<string[]> {
  const started = Date.now();
  let last: string[] = [];
  do {
    last = host.resolveActiveViewportIds();
    if (last.length > 0) return last;
    await delay(intervalMs);
  } while (Date.now() - started < timeoutMs);
  return last;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Execute an `OpenPlan` against a live OHIF host.  Returns nothing;
 * errors are thrown so the host can render a toast.
 *
 * The order of operations is significant:
 *
 *   1. Tell OHIF to load the series.  This blocks until DICOM frames
 *      are in the cache.
 *   2. Resolve the Cornerstone volume id from the series UID.
 *   3. Hand off to UncertaintyService. C0 marks the case current
 *      without inference; C1 imports the AI mask; C2 attaches the
 *      uncertainty heatmap.
 *
 * Failure between (1) and (3) leaves the viewer in a partially-loaded
 * state — that's acceptable in a thesis user study because the host
 * shows an error toast and the reviewer retries; we don't try to
 * roll back DICOM loads.
 */
export async function executeOpen(
  plan: OpenPlan,
  host: OpenCaseHost,
): Promise<void> {
  try {
    // OHIF's retrieve promise can remain pending during direct Study List
    // launches, even when the image is already visible in the viewport. Do not
    // let that strand the side panels in their optimistic "opening" state.
    await withTimeout(
      host.loadStudy({
        studyInstanceUID: plan.studyInstanceUID,
        seriesInstanceUID: plan.seriesInstanceUID,
      }),
      60_000,
      `[openUncertaintyCase] DICOM load for ${plan.caseId}`,
    );
  } catch (err) {
    // If a display set is already present, continue and let the volume/import
    // steps prove readiness. If not, the later failure is surfaced in-panel.
    // eslint-disable-next-line no-console
    console.warn('[openUncertaintyCase] Continuing after loadStudy warning:', err);
  }

  const referenceVolumeId = await withTimeout(
    host.resolveImageVolumeId(plan.seriesInstanceUID),
    60_000,
    `[openUncertaintyCase] volume resolution for ${plan.caseId}`,
  );

  if (!plan.runInference) {
    await host.servicesManager.services.uncertaintyService.openManualCase({
      caseId: plan.caseId,
      referenceVolumeId,
    });
    return;
  }

  const viewportIds = await waitForActiveViewportIds(host);
  if ((plan.importAiSegmentation || plan.attachHeatmap) && viewportIds.length === 0) {
    throw new Error(
      `[openUncertaintyCase] No active viewports to attach the AI mask/heatmap to after waiting. ` +
      `Was the layout fully initialised before opening case ${plan.caseId}?`,
    );
  }

  // Ensure the new study's display set is visible in the active viewport.
  // This is only needed when switching to a DIFFERENT study from the
  // worklist. For the first case (loaded from the Study List), OHIF's
  // hanging protocol already sets the correct display set.
  try {
    const gridSvc = host.servicesManager.services?.viewportGridService;
    const dss = host.servicesManager.services?.displaySetService;
    if (gridSvc && dss) {
      const newDisplaySet = dss.getDisplaySetsForSeries?.(plan.seriesInstanceUID)?.[0];
      const dsUid = newDisplaySet?.displaySetInstanceUID
        ?? newDisplaySet?.DisplaySetInstanceUID;
      if (dsUid) {
        // Check if the viewport already shows this display set (first load).
        const state = gridSvc.getState?.();
        const viewports = state?.viewports;
        let alreadyActive = false;
        if (viewports instanceof Map) {
          const activeVp = viewports.get(viewportIds[0]);
          alreadyActive = Boolean(activeVp?.displaySetInstanceUIDs?.includes?.(dsUid));
        }
        if (!alreadyActive) {
          for (const vpId of viewportIds) {
            gridSvc.setDisplaySetsForViewport?.({ viewportId: vpId, displaySetInstanceUIDs: [dsUid] });
          }
        }
      }
    }
  } catch {
    // Non-fatal.
  }

  await withTimeout(
    host.servicesManager.services.uncertaintyService.openCase({
      caseId: plan.caseId,
      referenceVolumeId,
      viewportIds,
    }),
    INFERENCE_IMPORT_TIMEOUT_MS,
    `[openUncertaintyCase] inference/import for ${plan.caseId}`,
  );
}

// ---------------------------------------------------------------------------
// Top-level command — what OHIF actually invokes
// ---------------------------------------------------------------------------

export async function openUncertaintyCase(
  args: { caseId: string },
  host: OpenCaseHost,
): Promise<void> {
  const condition = host.getCondition();
  const entry = host.getWorklistEntry(args.caseId);
  // If the URL/worklist launch supplied a StudyInstanceUID but the backend
  // worklist has a separate case_id, use the backend case_id for inference,
  // status updates, submissions, and the canonical URL.
  const resolvedCaseId = entry?.case_id ?? args.caseId;
  const planOrError = buildOpenPlan({
    caseId: resolvedCaseId,
    entry,
    condition,
  });

  if ('kind' in planOrError) {
    // eslint-disable-next-line no-console
    console.warn('[openUncertaintyCase] refusing to open:', planOrError);
    throw new Error(
      `Cannot open case ${resolvedCaseId}: ${planOrError.kind}` +
      ('condition' in planOrError ? ` (${planOrError.condition})` : ''),
    );
  }

  // The user's click has selected this case even if DICOM loading,
  // MONAILabel, or heatmap attachment later fails.  Update the canonical caseId URL parameter and
  // the service state before awaiting those slower operations, so refreshes,
  // screenshots, and the side panels all agree about the active case.
  updateCaseIdInUrl(planOrError.caseId);
  host.servicesManager.services.uncertaintyService.selectCase?.({
    caseId: planOrError.caseId,
  });

  try {
    await executeOpen(planOrError, host);
  } catch (err) {
    const message = errorMessage(err);
    host.servicesManager.services.uncertaintyService.markCaseOpenFailed?.({
      caseId: planOrError.caseId,
      error: message,
    });
    throw err;
  }
}

export function updateCaseIdInUrl(caseId: string): void {
  if (typeof window === 'undefined') return;
  const href = window.location?.href;
  const replaceState = window.history?.replaceState;
  if (!href || typeof replaceState !== 'function') return;

  const url = new URL(href);
  const hash = url.hash ?? '';
  const hashWithoutSharp = hash.startsWith('#') ? hash.slice(1) : hash;
  const hashQueryIndex = hashWithoutSharp.indexOf('?');

  if (hashQueryIndex >= 0) {
    const hashPath = hashWithoutSharp.slice(0, hashQueryIndex);
    const hashSearch = hashWithoutSharp.slice(hashQueryIndex + 1);
    const params = new URLSearchParams(hashSearch);
    params.delete('caseId');
    params.delete('case_id');
    params.set('caseId', caseId);
    params.set('case_id', caseId);
    url.hash = `#${hashPath}?${params.toString()}`;
  } else {
    url.searchParams.delete('caseId');
    url.searchParams.delete('case_id');
    url.searchParams.set('caseId', caseId);
    url.searchParams.set('case_id', caseId);
  }

  replaceState.call(window.history, null, '', url.toString());
}
