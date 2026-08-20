/**
 * OHIF v3 extension entry point.
 *
 * Exports the standard OHIF extension shape:
 *
 *   - `id`                  the extension's namespace
 *   - `getCommandsModule`   commands callable via `commandsManager.run(...)`
 *   - `getPanelModule`      panel registrations for the mode to mount
 *   - `preRegistration`     where we instantiate the singleton services
 *
 * The OHIF mode in `modes/uncertainty-review` references the panels and
 * commands defined here through their fully-qualified IDs (e.g.
 * `'@thesis/extension-uncertainty.panelModule.worklist'`).
 *
 * Why services are constructed in `preRegistration`:
 *
 *   `preRegistration` runs once at app startup with access to the
 *   `servicesManager` and `commandsManager`.  We attach
 *   `UncertaintyService` to the servicesManager under the name
 *   `'uncertaintyService'`, so any other extension or mode can read it
 *   the OHIF-idiomatic way.
 */

import { id } from './id';
import React from 'react';
import { EXTENSION_ID } from './types';
import { EventLogger } from './services/EventLogger';
import { HeatmapRenderer } from './services/HeatmapRenderer';
import type { CornerstoneAdapter } from './services/HeatmapRenderer';
import { UncertaintyService } from './services/UncertaintyService';
import type {
  SegmentationExportAdapter,
  SegmentationImportAdapter,
} from './services/UncertaintyService';
import { SubmissionApi } from './services/SubmissionApi';
import { WorklistApi } from './services/WorklistApi';
import { PanelWorklist } from './panels/PanelWorklist';
import { PanelUncertainty } from './panels/PanelUncertainty';
import { PanelSubmission } from './panels/PanelSubmission';

export { id };
export { UncertaintyService } from './services/UncertaintyService';
export { WorklistApi, WorklistApiError } from './services/WorklistApi';
export { SubmissionApi, SubmissionApiError } from './services/SubmissionApi';
export type {
  SubmissionOutcome,
  SubmissionStatus,
  AnnotationStatusOutcome,
} from './services/SubmissionApi';
export { EventLogger } from './services/EventLogger';
export { HeatmapRenderer } from './services/HeatmapRenderer';
export type { CornerstoneAdapter } from './services/HeatmapRenderer';
export type {
  SegmentationExportAdapter,
  SegmentationImportAdapter,
  SegmentationImportResult,
} from './services/UncertaintyService';
export * from './types';
export { loadNiftiFromUrl, parseNifti } from './utils/loadNifti';
export type { NiftiVolume } from './utils/loadNifti';

// ---------------------------------------------------------------------------
// Configuration shape — populated by the OHIF host's app config.
// ---------------------------------------------------------------------------

interface ExtensionConfig {
  /** Base URL of the FastAPI uncertainty service. */
  uncertaintyServiceUrl?: string;
  /**
   * Cornerstone adapter implementation, provided by the host app
   * because the right way to call Cornerstone3D depends on the OHIF
   * version in use.  See `src/services/HeatmapRenderer.ts` for the
   * required interface.
   */
  cornerstoneAdapter?: CornerstoneAdapter;
  /**
   * Segmentation exporter, also host-supplied, for the same
   * version-sensitivity reasons as `cornerstoneAdapter`.  See
   * `src/services/UncertaintyService.ts` for the required interface.
   */
  segmentationExporter?: SegmentationExportAdapter;
  /**
   * Host-supplied importer that turns the MONAILabel/FastAPI segmentation_url
   * into an editable OHIF segmentation. Required for C1 and C2.
   */
  segmentationImporter?: SegmentationImportAdapter;
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Internal helper: cast through `any` for OHIF servicesManager
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyServices = any;

class MissingUncertaintyDependencyError extends Error {
  constructor(public readonly dependency: string) {
    super(
      `[${EXTENSION_ID}] Missing ${dependency}. ` +
      'Normal OHIF startup can continue, but this uncertainty action requires configuration.',
    );
    this.name = 'MissingUncertaintyDependencyError';
  }
}

function rejectMissing<T>(dependency: string): Promise<T> {
  return Promise.reject(new MissingUncertaintyDependencyError(dependency));
}

function createMissingWorklistApi(): Pick<WorklistApi, 'getWorklist' | 'runInference' | 'postEvents' | 'postEventsBeacon'> {
  return {
    getWorklist: () => rejectMissing('uncertaintyServiceUrl'),
    runInference: () => rejectMissing('uncertaintyServiceUrl'),
    postEvents: () => rejectMissing('uncertaintyServiceUrl'),
    postEventsBeacon: () => false,
  };
}

function createMissingSubmissionApi(): Pick<SubmissionApi, 'submit' | 'updateStatus' | 'getAnnotation'> {
  return {
    submit: () => rejectMissing('uncertaintyServiceUrl'),
    updateStatus: () => rejectMissing('uncertaintyServiceUrl'),
    getAnnotation: () => rejectMissing('uncertaintyServiceUrl'),
  };
}

function createMissingCornerstoneAdapter(): CornerstoneAdapter {
  return {
    createDerivedScalarVolume: () => rejectMissing<string>('cornerstoneAdapter'),
    addVolumeToViewports: () => rejectMissing<void>('cornerstoneAdapter'),
    applyTransferFunctions: () => { throw new MissingUncertaintyDependencyError('cornerstoneAdapter'); },
    setVolumeVisible: () => { throw new MissingUncertaintyDependencyError('cornerstoneAdapter'); },
    removeVolume: () => rejectMissing<void>('cornerstoneAdapter'),
    renderViewports: () => undefined,
  };
}

function createMissingSegmentationExporter(): SegmentationExportAdapter {
  return {
    exportSegmentationAsNiftiBlob: () => rejectMissing('segmentationExporter'),
  };
}

function createMissingSegmentationImporter(): SegmentationImportAdapter {
  return {
    importSegmentation: () => rejectMissing('segmentationImporter'),
    removeSegmentation: () => Promise.resolve(),
  };
}

function getFetchImpl(cfg: Partial<ExtensionConfig>): typeof fetch {
  return cfg.fetchImpl
    ?? globalThis.fetch?.bind(globalThis)
    ?? (() => rejectMissing<Response>('fetchImpl'));
}

function getConfig(extensionManager: AnyServices): Partial<ExtensionConfig> {
  return extensionManager?.getModuleEntry?.(`${EXTENSION_ID}.config`)?.config
    ?? extensionManager?._appConfig?.uncertainty
    ?? {};
}


function getCurrentLocationSearch(): string {
  if (typeof window === 'undefined' || !window.location) return '';

  const parts: string[] = [];
  const normalSearch = window.location.search;
  if (normalSearch) {
    parts.push(normalSearch.startsWith('?') ? normalSearch.slice(1) : normalSearch);
  }

  // Some OHIF deployments use hash routing, e.g.
  //   /#/viewer/uncertainty-review?reviewer=R03&condition=C2&caseId=case_001
  // In that case window.location.search is empty and the route query lives
  // inside window.location.hash.  Parse it as well so the review session
  // survives both BrowserRouter and HashRouter builds.
  const hash = window.location.hash ?? '';
  const hashQueryIndex = hash.indexOf('?');
  if (hashQueryIndex >= 0) {
    const hashSearch = hash.slice(hashQueryIndex + 1).split('#')[0];
    if (hashSearch) parts.push(hashSearch);
  }

  return parts.length ? `?${parts.join('&')}` : '';
}

// ---------------------------------------------------------------------------
// preRegistration — wire up the singleton service
// ---------------------------------------------------------------------------

interface PreRegistrationContext {
  servicesManager: AnyServices;
  commandsManager: AnyServices;
  extensionManager: AnyServices;
  configuration?: Partial<ExtensionConfig>;
}

function preRegistration({
  servicesManager,
  configuration,
  extensionManager,
}: PreRegistrationContext): void {
  const cfg: Partial<ExtensionConfig> = {
    ...getConfig(extensionManager),
    ...configuration,
  };

  const api = cfg.uncertaintyServiceUrl
    ? new WorklistApi({
      baseUrl: cfg.uncertaintyServiceUrl,
      fetchImpl: cfg.fetchImpl,
    })
    : createMissingWorklistApi();

  const submissionApi = cfg.uncertaintyServiceUrl
    ? new SubmissionApi({
      baseUrl: cfg.uncertaintyServiceUrl,
      fetchImpl: cfg.fetchImpl,
    })
    : createMissingSubmissionApi();

  const renderer = new HeatmapRenderer({
    adapter: cfg.cornerstoneAdapter ?? createMissingCornerstoneAdapter(),
    fetchImpl: getFetchImpl(cfg),
  });

  const service = new UncertaintyService({
    api,
    submissionApi,
    exporter: cfg.segmentationExporter ?? createMissingSegmentationExporter(),
    segmentationImporter: cfg.segmentationImporter ?? createMissingSegmentationImporter(),
    logger: new EventLogger({ api }),
    renderer,
  });

  // Try to apply session from URL — modes calling this on entry get
  // the same effect, but doing it here means tests that bypass the
  // mode still get a session.
  const currentLocationSearch = getCurrentLocationSearch();
  if (currentLocationSearch) {
    service.applySessionFromQuery(currentLocationSearch);
  }

  servicesManager.registerService?.({
    name: 'uncertaintyService',
    create: () => service,
  });
  // Also store on a well-known key so non-OHIF callers can grab it.
  servicesManager.services = servicesManager.services ?? {};
  servicesManager.services.uncertaintyService = service;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function getCommandsModule({ servicesManager }: PreRegistrationContext) {
  const getService = (): UncertaintyService =>
    servicesManager.services.uncertaintyService;

  return {
    definitions: {
      toggleUncertaintyHeatmap: {
        commandName: 'toggleUncertaintyHeatmap',
        commandFn: () => getService().toggleHeatmap(),
      },
      setUncertaintyHeatmapOpacity: {
        commandName: 'setUncertaintyHeatmapOpacity',
        commandFn: ({ opacity }: { opacity: number }) =>
          getService().setHeatmapOpacity(opacity),
      },
      acceptUncertaintyAnnotation: {
        commandName: 'acceptUncertaintyAnnotation',
        commandFn: () => getService().acceptCurrent(),
      },
      rejectUncertaintyAnnotation: {
        commandName: 'rejectUncertaintyAnnotation',
        commandFn: ({ reason }: { reason?: string } = {}) =>
          getService().rejectCurrent(reason),
      },
      escalateUncertaintyCase: {
        commandName: 'escalateUncertaintyCase',
        commandFn: ({ reason }: { reason?: string } = {}) =>
          getService().escalateCurrent(reason),
      },
      submitUncertaintyAnnotation: {
        commandName: 'submitUncertaintyAnnotation',
        commandFn: ({ status, reason }: {
          status: 'accepted' | 'edited' | 'rejected' | 'escalated';
          reason?: string;
        }) => getService().submitAnnotation({ status, reason }),
      },
      refreshUncertaintyWorklist: {
        commandName: 'refreshUncertaintyWorklist',
        commandFn: () => getService().refreshWorklist(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function getPanelModule({ servicesManager, commandsManager }: PreRegistrationContext) {
  const getService = (): UncertaintyService =>
    servicesManager.services.uncertaintyService;

  return [
    {
      name: 'worklist',
      iconName: 'tab-studies',
      iconLabel: 'Worklist',
      label: 'Uncertainty Worklist',
      component: () => {
        const service = getService();
        // The mode supplies a real `openCase` command; we proxy it
        // through commandsManager so the panel doesn't need to know
        // about the host app's data-source plumbing.
        const onOpenCase = (caseId: string): void | Promise<void> => {
          // Prefer the direct openCaseCommand callback set up by the mode
          // during onModeEnter. This bypasses commandsManager.runCommand
          // which may not properly propagate async command results in all
          // OHIF v3 versions.
          if (service.openCaseCommand) {
            return service.openCaseCommand(caseId);
          }
          const result = commandsManager.runCommand?.('openUncertaintyCase', { caseId });
          return result && typeof result.then === 'function' ? result : undefined;
        };
        return React.createElement(PanelWorklist, { service, onOpenCase });
      },
    },
    {
      name: 'uncertainty',
      iconName: 'tool-fusion-color',
      iconLabel: 'Uncertainty',
      label: 'Uncertainty',
      component: () => {
        const service = getService();
        return React.createElement(PanelUncertainty, { service });
      },
    },
    {
      name: 'submission',
      iconName: 'tool-create-threshold',
      iconLabel: 'Submit',
      label: 'Submission',
      component: () => {
        const service = getService();
        return React.createElement(PanelSubmission, { service });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Default export — the OHIF extension manifest
// ---------------------------------------------------------------------------

export default {
  id,
  preRegistration,
  getCommandsModule,
  getPanelModule,
};
