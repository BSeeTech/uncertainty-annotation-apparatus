/**
 * OHIF v3 mode — `@thesis/mode-uncertainty-review`.
 *
 * The mode is the host-side glue:
 *
 *   - declares the viewport layout (one main viewport, two side panels),
 *   - registers commands the panels call into,
 *   - installs the Cornerstone adapter,
 *   - on entry, parses ?reviewer=&condition= and configures the
 *     UncertaintyService session,
 *   - on exit, flushes pending events and detaches the heatmap.
 *
 * The mode is deliberately thin.  The thesis-relevant logic — the
 * C0/C1/C2 contract, the heatmap, the worklist, the event logger —
 * all lives in the extension package and is exhaustively unit-tested
 * there.  The mode only has to plug it into OHIF.
 */

import { id as MODE_ID } from './id';
import { id as EXTENSION_ID } from '@thesis/extension-uncertainty';
import { hotkeys } from '@ohif/core';
import * as cornerstone from '@cornerstonejs/core';
import * as cstoneTools from '@cornerstonejs/tools';
import type {
  Condition,
  UncertaintyService,
  WorklistEntry,
} from '@thesis/extension-uncertainty';
import { HeatmapRenderer } from '@thesis/extension-uncertainty';

import { parseSessionFromSearch, describeSession } from './sessionConfig';
import { createCornerstoneAdapter } from './adapter/createCornerstoneAdapter';
import { createSegmentationExportAdapter } from './adapter/createSegmentationExportAdapter';
import { createSegmentationImportAdapter } from './adapter/createSegmentationImportAdapter';
import {
  openUncertaintyCase,
  updateCaseIdInUrl,
  type OpenCaseHost,
} from './commands/openUncertaintyCase';

// Loose host typings — see comment in createCornerstoneAdapter.ts for
// why we don't try to type the OHIF surface tightly here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyServices = any;

function asList(value: AnyServices): AnyServices[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return Array.from(value.values());
  if (typeof value === 'object') return Object.values(value);
  return [];
}

function maybeString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function uniqueByIdentity(items: AnyServices[]): AnyServices[] {
  const seen = new Set<AnyServices>();
  const out: AnyServices[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function getDisplaySetsFromService(displaySetService: AnyServices): AnyServices[] {
  const candidates: AnyServices[] = [];
  const addMany = (value: AnyServices) => candidates.push(...asList(value));

  addMany(displaySetService?.getActiveDisplaySets?.());
  addMany(displaySetService?.getDisplaySets?.());
  addMany(displaySetService?.activeDisplaySets);
  addMany(displaySetService?.displaySets);
  addMany(displaySetService?._displaySets);

  return uniqueByIdentity(candidates);
}

function findDisplaySetForSeries(
  displaySetService: AnyServices,
  seriesInstanceUID: string,
): AnyServices | null {
  const direct = displaySetService?.getDisplaySetsForSeries?.(seriesInstanceUID);
  const directFirst = asList(direct)[0];
  if (directFirst) return directFirst;

  return getDisplaySetsFromService(displaySetService).find(ds =>
    ds?.SeriesInstanceUID === seriesInstanceUID
    || ds?.seriesInstanceUID === seriesInstanceUID
    || ds?.series?.SeriesInstanceUID === seriesInstanceUID,
  ) ?? null;
}

function firstDisplaySetWithStudyAndSeries(displaySetService: AnyServices): AnyServices | null {
  return getDisplaySetsFromService(displaySetService).find(ds =>
    maybeString(ds?.StudyInstanceUID ?? ds?.studyInstanceUID ?? ds?.study?.StudyInstanceUID)
    && maybeString(ds?.SeriesInstanceUID ?? ds?.seriesInstanceUID ?? ds?.series?.SeriesInstanceUID),
  ) ?? null;
}

function displaySetUID(ds: AnyServices): string | null {
  return maybeString(
    ds?.displaySetInstanceUID
    ?? ds?.DisplaySetInstanceUID
    ?? ds?.displaySetUID
    ?? ds?.id
    ?? ds?.uid,
  );
}

function studyUID(ds: AnyServices): string | null {
  return maybeString(ds?.StudyInstanceUID ?? ds?.studyInstanceUID ?? ds?.study?.StudyInstanceUID);
}

function seriesUID(ds: AnyServices): string | null {
  return maybeString(ds?.SeriesInstanceUID ?? ds?.seriesInstanceUID ?? ds?.series?.SeriesInstanceUID);
}

function uniqueStrings(items: Array<string | null | undefined>): string[] {
  return Array.from(new Set(items.filter((v): v is string => typeof v === 'string' && v.length > 0)));
}

function imageIdsFromDisplaySet(displaySet: AnyServices): string[] {
  const candidates: unknown[] = [];
  const add = (value: unknown): void => {
    if (!value) return;
    if (typeof value === 'string') {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      candidates.push(...value);
    }
  };

  add(displaySet?.imageIds);
  add(displaySet?.images?.map?.((image: AnyServices) => image?.imageId ?? image?.id));
  add(displaySet?.instances?.map?.((instance: AnyServices) =>
    instance?.imageId ?? instance?.wadorsuri ?? instance?.url
  ));

  return uniqueStrings(candidates.map(value => maybeString(value)));
}

async function ensureReferenceVolumeCached(
  referenceVolumeId: string,
  displaySet: AnyServices,
): Promise<void> {
  const cache: AnyServices = (cornerstone as AnyServices).cache;
  const volumeLoader: AnyServices = (cornerstone as AnyServices).volumeLoader;

  if (cache?.getVolume?.(referenceVolumeId)) {
    return;
  }

  if (typeof volumeLoader?.createAndCacheVolume !== 'function') {
    return;
  }

  const imageIds = imageIdsFromDisplaySet(displaySet);
  if (!imageIds.length) {
    return;
  }

  const volume = await Promise.resolve(
    volumeLoader.createAndCacheVolume(referenceVolumeId, { imageIds }),
  );
  await Promise.resolve(volume?.load?.());
}

async function waitForDisplaySetUID(
  displaySetService: AnyServices,
  seriesInstanceUID: string,
  intervalMs = 200,
): Promise<string> {
  let elapsed = 0;
  const warnAt = [5_000, 15_000, 30_000];
  return new Promise(resolve => {
    const poll = () => {
      const target = findDisplaySetForSeries(displaySetService, seriesInstanceUID);
      const uid = displaySetUID(target);
      if (uid) {
        return resolve(uid);
      }
      elapsed += intervalMs;
      const nextWarn = warnAt.find(w => elapsed >= w);
      if (nextWarn) {
        warnAt.splice(warnAt.indexOf(nextWarn), 1);
        // eslint-disable-next-line no-console
        console.warn(
          `[waitForDisplaySetUID] Still waiting for display set for series ${seriesInstanceUID} after ${elapsed}ms`,
        );
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

function getCurrentRouteSearch(): string {
  if (typeof window === 'undefined' || !window.location) return '';

  const parts: string[] = [];
  const normalSearch = window.location.search;
  if (normalSearch) {
    parts.push(normalSearch.startsWith('?') ? normalSearch.slice(1) : normalSearch);
  }

  // Support OHIF BrowserRouter and HashRouter deployments.  In hash-routed
  // builds the route query is after '#', so window.location.search is empty.
  const hash = window.location.hash ?? '';
  const hashQueryIndex = hash.indexOf('?');
  if (hashQueryIndex >= 0) {
    const hashSearch = hash.slice(hashQueryIndex + 1).split('#')[0];
    if (hashSearch) parts.push(hashSearch);
  }

  return parts.length ? `?${parts.join('&')}` : '';
}

const SESSION_STORAGE_KEY = 'uncertainty-review-session';
const MONAI_LABEL_PANEL = '@ohif/extension-monai-label.panelModule.monailabel';
const SEGMENTATION_PANEL_WITH_TOOLS = '@ohif/extension-cornerstone-dicom-seg.panelModule.panelSegmentationWithTools';
const SEGMENTATION_VIEWPORT = '@ohif/extension-cornerstone-dicom-seg.viewportModule.dicom-seg';
const SEGMENTATION_SOP_CLASS_HANDLER = '@ohif/extension-cornerstone-dicom-seg.sopClassHandlerModule.dicom-seg';

const DEFAULT_DIRECT_LAUNCH_REVIEWER_ID = 'R03';
const DEFAULT_DIRECT_LAUNCH_CONDITION: Condition = 'C2';
const UNCERTAINTY_VOLUME_HP_ID = 'uncertainty-volume';

/**
 * Condition-specific display names for mode buttons in the study list.
 * These can be overridden via modeConfiguration.
 */
const CONDITION_DISPLAY_NAMES: Record<string, string> = {
  C0: 'Manual',
  C1: 'MONAILabel',
  C2: 'Uncertainty-Guided Review',
  C3: 'Placebo Saliency',
  C4: 'Prioritised Worklist',
  C5: 'Heatmap Only',
};

const CONDITION_ROUTE_SUFFIXES: Record<string, string> = {
  C0: 'manual-review',
  C1: 'monailabel-review',
  C2: 'uncertainty-review',
  C3: 'placebo-saliency',
  C4: 'prioritised-worklist',
  C5: 'heatmap-only',
};

function paramsFromSearch(search: string): URLSearchParams {
  return new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
}

function searchFromParams(params: URLSearchParams): string {
  const serialised = params.toString();
  return serialised ? `?${serialised}` : '';
}

function replaceRouteParams(updates: Record<string, string | null>): void {
  if (typeof window === 'undefined') return;
  const href = window.location?.href;
  const replaceState = window.history?.replaceState;
  if (!href || typeof replaceState !== 'function') return;

  const url = new URL(href);
  const apply = (params: URLSearchParams): void => {
    for (const [key, value] of Object.entries(updates)) {
      if (value == null) params.delete(key);
      else params.set(key, value);
    }
  };

  const hash = url.hash ?? '';
  const hashWithoutSharp = hash.startsWith('#') ? hash.slice(1) : hash;
  const hashQueryIndex = hashWithoutSharp.indexOf('?');

  if (hashQueryIndex >= 0) {
    const hashPath = hashWithoutSharp.slice(0, hashQueryIndex);
    const hashSearch = hashWithoutSharp.slice(hashQueryIndex + 1);
    const params = new URLSearchParams(hashSearch);
    apply(params);
    url.hash = `#${hashPath}${searchFromParams(params)}`;
  } else {
    apply(url.searchParams);
  }

  replaceState.call(window.history, null, '', url.toString());
}

function ensureDefaultDirectLaunchSession(
  search: string,
  defaultCondition?: Condition,
): string {
  const condition = defaultCondition ?? DEFAULT_DIRECT_LAUNCH_CONDITION;
  const params = paramsFromSearch(search);
  const updates: Record<string, string | null> = {};

  if (!params.get('reviewer')) {
    params.set('reviewer', DEFAULT_DIRECT_LAUNCH_REVIEWER_ID);
    updates.reviewer = DEFAULT_DIRECT_LAUNCH_REVIEWER_ID;
  }
  if (!params.get('condition')) {
    params.set('condition', condition);
    updates.condition = condition;
  }

  if (Object.keys(updates).length > 0) {
    replaceRouteParams(updates);
  }

  return searchFromParams(params);
}

function getStudyInstanceUIDsFromSearch(search: string): string[] {
  const params = paramsFromSearch(search);
  const raw = params.get('StudyInstanceUIDs')
    ?? params.get('studyInstanceUIDs')
    ?? params.get('StudyInstanceUID')
    ?? params.get('studyInstanceUID')
    ?? '';

  return raw
    .split(/[\\,]/)
    .map(v => v.trim())
    .filter(Boolean);
}

function inferCaseIdFromSelectedStudy(
  search: string,
  uncertaintyService: UncertaintyService,
): string | null {
  const params = paramsFromSearch(search);
  const explicit = params.get('caseId') ?? params.get('case_id');
  const selectedStudyUIDs = getStudyInstanceUIDsFromSearch(search);
  const selected = new Set(selectedStudyUIDs);
  const items = uncertaintyService.getState().worklist.items;

  if (explicit) {
    const explicitMatch = items.find(item =>
      item.case_id === explicit || item.study_uid === explicit || item.series_uid === explicit,
    );
    if (explicitMatch) return explicitMatch.case_id;
  }

  const selectedMatch = items.find(item =>
    selected.has(item.case_id) || selected.has(item.study_uid) || selected.has(item.series_uid),
  );
  if (selectedMatch) return selectedMatch.case_id;

  return explicit ?? null;
}

function mergeStoredSessionIntoSearch(search: string): string {
  if (typeof window === 'undefined') return search;
  let rawStored: string | null = null;
  try {
    rawStored = window.sessionStorage?.getItem(SESSION_STORAGE_KEY) ?? null;
  } catch {
    rawStored = null;
  }
  if (!rawStored) return search;

  let stored: { reviewerId?: string; condition?: string } | null = null;
  try {
    stored = JSON.parse(rawStored);
  } catch {
    return search;
  }
  if (!stored?.reviewerId || !stored?.condition) return search;

  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  if (!params.get('reviewer')) params.set('reviewer', stored.reviewerId);
  if (!params.get('condition')) params.set('condition', stored.condition);

  return `?${params.toString()}`;
}

function rememberSessionForRoute(session: ReturnType<typeof parseSessionFromSearch>): void {
  if (!session || typeof window === 'undefined') return;
  try {
    window.sessionStorage?.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        reviewerId: session.reviewerId,
        condition: session.condition,
      }),
    );
  } catch {
    // Private browsing / blocked storage should not break the review mode.
  }
}

type RuntimeConfigurableUncertaintyService = UncertaintyService & {
  configureRuntimeDependencies?: (deps: {
    renderer: HeatmapRenderer;
    exporter: ReturnType<typeof createSegmentationExportAdapter>;
    segmentationImporter: ReturnType<typeof createSegmentationImportAdapter>;
  }) => void;
};

function getSegmentationIdentifier(segmentation: AnyServices): string | null {
  return segmentation?.segmentationId ?? segmentation?.id ?? null;
}

function segmentationReferencesVolume(segmentation: AnyServices, referenceVolumeId: string): boolean {
  const repr = segmentation?.representationData?.LABELMAP
    ?? segmentation?.representationData?.Labelmap
    ?? segmentation?.representationData;

  return repr?.referencedVolumeId === referenceVolumeId
    || repr?.volumeId === referenceVolumeId;
}

function segmentationHasVolumeReference(segmentation: AnyServices): boolean {
  const repr = segmentation?.representationData?.LABELMAP
    ?? segmentation?.representationData?.Labelmap
    ?? segmentation?.representationData;

  return Boolean(repr?.referencedVolumeId || repr?.volumeId);
}

function normalizeSegmentations(segmentations: AnyServices): AnyServices[] {
  return Array.isArray(segmentations) ? segmentations : segmentations ? [segmentations] : [];
}

export function resolveSegmentationIdForReference({
  segmentationService,
  referenceVolumeId,
  preferredSegmentationId,
}: {
  segmentationService: AnyServices | undefined;
  referenceVolumeId: string;
  preferredSegmentationId?: string | null;
}): string | null {
  if (!segmentationService) {
    return null;
  }

  if (preferredSegmentationId && typeof segmentationService.getSegmentation === 'function') {
    const preferred = segmentationService.getSegmentation(preferredSegmentationId);
    if (
      preferred
      && (!referenceVolumeId
        || !segmentationHasVolumeReference(preferred)
        || segmentationReferencesVolume(preferred, referenceVolumeId))
    ) {
      return preferredSegmentationId;
    }
  }

  // v3.10+: getSegmentationsByReferenceVolumeId(...)
  if (typeof segmentationService.getSegmentationsByReferenceVolumeId === 'function') {
    const segmentations = normalizeSegmentations(
      segmentationService.getSegmentationsByReferenceVolumeId(referenceVolumeId),
    );
    const preferred = preferredSegmentationId
      ? segmentations.find(segmentation => getSegmentationIdentifier(segmentation) === preferredSegmentationId)
      : null;
    const match = preferred ?? segmentations.find(Boolean);
    const matchId = getSegmentationIdentifier(match);
    if (matchId) {
      return matchId;
    }
  }

  // OHIF V2 service path: enumerate segmentations and pick the one whose
  // representation references our volume id. Prefer the imported AI mask
  // for the current case when present so submission exports the visible mask.
  if (typeof segmentationService.getSegmentations === 'function') {
    const all = normalizeSegmentations(segmentationService.getSegmentations());
    const referenceMatches = all.filter(segmentation =>
      segmentationReferencesVolume(segmentation, referenceVolumeId)
    );
    const preferred = preferredSegmentationId
      ? referenceMatches.find(segmentation =>
        getSegmentationIdentifier(segmentation) === preferredSegmentationId
      )
      : null;
    const match = preferred ?? referenceMatches[0];
    const matchId = getSegmentationIdentifier(match);
    if (matchId) {
      return matchId;
    }
  }

  // Cornerstone3D V3 native state lookup: manually-created segmentations
  // (C0/Manual) live only in Cornerstone's native segmentation state,
  // never in OHIF's segmentationService.  Query the tools state directly
  // so the manual annotation can be exported for submission.
  const segTools: AnyServices = cstoneTools as AnyServices;
  const segApi = segTools?.segmentation;
  if (!segApi) return null;

  // V3 API: segmentation.getSegmentations()
  let allCS: AnyServices[] = [];
  if (typeof segApi.state?.getSegmentations === 'function') {
    allCS = normalizeSegmentations(segApi.state.getSegmentations());
  }

  // V3 API: segmentation.getActiveSegmentation(viewportId)
  const getActiveSegFn: ((vpId: string) => AnyServices) | undefined =
    typeof segApi.getActiveSegmentation === 'function'
      ? (vpId: string) => segApi.getActiveSegmentation(vpId)
      : undefined;

  // V3 API: segmentation.state.getViewportIdsWithSegmentation(segmentationId)
  // requires a segmentationId argument (unlike V2 which accepted none to mean "all").
  if (allCS.length === 0 && getActiveSegFn) {
    let viewportIds: string[] = [];

    // Enumerate all segmentations and collect viewport IDs per segmentation.
    // We already have allCS (empty here), so fetch segmentations again if needed.
    const allSegmentations: AnyServices[] =
      typeof segApi.state?.getSegmentations === 'function'
        ? normalizeSegmentations(segApi.state.getSegmentations())
        : [];

    if (typeof segApi.state?.getViewportIdsWithSegmentation === 'function') {
      for (const seg of allSegmentations) {
        const segId = getSegmentationIdentifier(seg);
        if (!segId) continue;
        const ids = segApi.state.getViewportIdsWithSegmentation(segId);
        if (Array.isArray(ids)) viewportIds.push(...ids);
      }
      viewportIds = [...new Set(viewportIds)];
    }

    if (viewportIds.length > 0) {
      // First pass: match by reference volume
      for (const vpId of viewportIds) {
        const active = getActiveSegFn(vpId);
        if (active && segmentationReferencesVolume(active, referenceVolumeId)) {
          const id = getSegmentationIdentifier(active);
          if (id) return id;
        }
      }
      // Last resort: return ANY active segmentation (C0 manual may lack ref volume)
      for (const vpId of viewportIds) {
        const active = getActiveSegFn(vpId);
        if (active) {
          const id = getSegmentationIdentifier(active);
          if (id) return id;
        }
      }
    }
  }

  // Fallback: use all segmentations we collected, preferring volume match
  if (allCS.length > 0) {
    const refMatch = allCS.find((seg: AnyServices) =>
      segmentationReferencesVolume(seg, referenceVolumeId)
    ) ?? allCS.find(Boolean);
    const matchId = getSegmentationIdentifier(refMatch);
    if (matchId) return matchId;
  }

  return null;
}

function buildRuntimeDependencies(servicesManager: AnyServices) {
  const fetchImpl = globalThis.fetch?.bind(globalThis)
    ?? (() => Promise.reject(new Error('[uncertainty-review] fetch is not available')));
  const cornerstoneAdapter = createCornerstoneAdapter({
    getRenderingEngine: () =>
      servicesManager.services.cornerstoneViewportService?.getRenderingEngine?.(),
    getViewport: (viewportId: string) =>
      servicesManager.services.cornerstoneViewportService?.getCornerstoneViewport?.(viewportId)
      ?? null,
  });

  const segmentationExporter = createSegmentationExportAdapter({
    getSegmentationIdForReference: (referenceVolumeId: string): string | null => {
      const currentCase = servicesManager.services.uncertaintyService?.getState?.().currentCase;
      const preferredSegmentationId = currentCase?.caseId
        ? `uncertainty:monailabel-seg:${currentCase.caseId}`
        : null;

      return resolveSegmentationIdForReference({
        segmentationService: servicesManager.services.segmentationService,
        referenceVolumeId,
        preferredSegmentationId,
      });
    },
  });

  const segmentationImporter = createSegmentationImportAdapter({
    servicesManager,
    fetchImpl: globalThis.fetch?.bind(globalThis),
  });

  return {
    cornerstoneAdapter,
    renderer: new HeatmapRenderer({ adapter: cornerstoneAdapter, fetchImpl }),
    segmentationExporter,
    segmentationImporter,
  };
}

function configureUncertaintyRuntimeDependencies({
  servicesManager,
  extensionManager,
}: {
  servicesManager: AnyServices;
  extensionManager?: AnyServices;
}) {
  const deps = buildRuntimeDependencies(servicesManager);
  const uncertaintyService: RuntimeConfigurableUncertaintyService | undefined =
    servicesManager.services?.uncertaintyService;

  uncertaintyService?.configureRuntimeDependencies?.({
    renderer: deps.renderer,
    exporter: deps.segmentationExporter,
    segmentationImporter: deps.segmentationImporter,
    openCaseCommand: (caseId: string) =>
      openUncertaintyCase(
        { caseId },
        buildOpenCaseHost({ servicesManager, extensionManager }),
      ),
  });

  if (extensionManager?._appConfig) {
    extensionManager._appConfig.uncertainty =
      extensionManager._appConfig.uncertainty ?? {};
    extensionManager._appConfig.uncertainty.cornerstoneAdapter = deps.cornerstoneAdapter;
    extensionManager._appConfig.uncertainty.segmentationExporter = deps.segmentationExporter;
    extensionManager._appConfig.uncertainty.segmentationImporter = deps.segmentationImporter;
  }

  return deps;
}

interface ModeFactoryArgs {
  modeConfiguration?: ModeConfigOverrides;
}

const extensionDependencies = {
  '@ohif/extension-default': '^3.0.0',
  '@ohif/extension-cornerstone': '^3.0.0',
  '@ohif/extension-cornerstone-dicom-seg': '^3.0.0',
  '@ohif/extension-monai-label': '^3.0.0',
  [EXTENSION_ID]: '^0.1.0',
};

function buildOpenCaseHost({
  servicesManager,
  extensionManager,
}: {
  servicesManager: AnyServices;
  extensionManager: AnyServices;
}): OpenCaseHost {
  const uncertaintyService: UncertaintyService =
    servicesManager.services.uncertaintyService;

  return {
    getWorklistEntry(caseId: string): WorklistEntry | null {
      const items = uncertaintyService.getState().worklist.items;
      const fromWorklist = items.find(it =>
        it.case_id === caseId || it.study_uid === caseId || it.series_uid === caseId,
      );
      if (fromWorklist) return fromWorklist;

      // Fallback for the common development path where the reviewer opens
      // a study through the normal OHIF study browser instead of through
      // the uncertainty worklist. Without this, buildOpenPlan returns
      // unknown_case, UncertaintyService never receives openManualCase/openCase,
      // and the Submission/Uncertainty panels stay disabled forever.
      const ds = firstDisplaySetWithStudyAndSeries(
        servicesManager.services.displaySetService,
      );
      const fallbackStudyUID = studyUID(ds);
      const fallbackSeriesUID = seriesUID(ds);
      if (!fallbackStudyUID || !fallbackSeriesUID) return null;

      return {
        case_id: caseId,
        patient_id: maybeString(ds?.PatientID ?? ds?.patientId) ?? null,
        study_uid: fallbackStudyUID,
        series_uid: fallbackSeriesUID,
        score: null,
        score_band: null,
        inference_status: null,
        status: 'ready',
      };
    },
    getCondition: () =>
      uncertaintyService.getState().session?.condition ?? null,
    servicesManager,
    async loadStudy({ studyInstanceUID, seriesInstanceUID }) {
      // If the display set for this series already exists, the study was
      // loaded by OHIF before the mode entered (first case from Study List).
      // Skip re-retrieving metadata to avoid disrupting the viewport setup.
      const dss = servicesManager.services.displaySetService;
      const existing = dss?.getDisplaySetsForSeries?.(seriesInstanceUID);
      if (existing && existing.length > 0) {
        return;
      }

      // The data source's `retrieve.series.metadata` is the DICOMweb-canonical
      // way to fetch a specific series. It retrieves instances, stores them in
      // DicomMetadataStore, and triggers display set creation.
      const ds = extensionManager?.getActiveDataSource?.()?.[0]
        ?? extensionManager?.getDataSources?.()?.[0];
      if (!ds) {
        throw new Error('[openUncertaintyCase] No active data source.');
      }
      if (typeof ds.retrieve?.series?.metadata === 'function') {
        await ds.retrieve.series.metadata({
          StudyInstanceUID: studyInstanceUID,
          filters: { SeriesInstanceUIDs: [seriesInstanceUID] },
        });
      } else {
        throw new Error(
          '[openUncertaintyCase] Active data source has no retrieve.series.metadata method. Cannot load DICOM.',
        );
      }
    },
    async resolveImageVolumeId(seriesInstanceUID: string): Promise<string> {
      const dss = servicesManager.services.displaySetService;
      const uid = await waitForDisplaySetUID(dss, seriesInstanceUID);
      const referenceVolumeId = `cornerstoneStreamingImageVolume:${uid}`;
      await ensureReferenceVolumeCached(
        referenceVolumeId,
        findDisplaySetForSeries(dss, seriesInstanceUID),
      );

      return referenceVolumeId;
    },
    resolveActiveViewportIds(): string[] {
      const grid = servicesManager.services.viewportGridService;
      const state = grid?.getState?.();
      const csv = servicesManager.services.cornerstoneViewportService;
      const ids: Array<string | null | undefined> = [];

      ids.push(maybeString(state?.activeViewportId));

      const viewports = state?.viewports;
      if (viewports instanceof Map) {
        ids.push(...Array.from(viewports.keys()).map(k => maybeString(k)));
        ids.push(...Array.from(viewports.values()).map(v =>
          maybeString(v?.viewportId ?? v?.id),
        ));
      } else if (Array.isArray(viewports)) {
        ids.push(...viewports.map(v => maybeString(v?.viewportId ?? v?.id)));
      } else if (viewports && typeof viewports === 'object') {
        ids.push(...Object.keys(viewports));
        ids.push(...Object.values(viewports).map((v: AnyServices) =>
          maybeString(v?.viewportId ?? v?.id),
        ));
      }

      ids.push(...asList(csv?.getViewportIds?.()).map(v => maybeString(v)));
      return uniqueStrings(ids);
    },
  };
}

// ---------------------------------------------------------------------------
// Entry / exit hooks
// ---------------------------------------------------------------------------

interface OnModeEnterArgs {
  servicesManager: AnyServices;
  extensionManager: AnyServices;
  commandsManager: AnyServices;
}

interface ModeConfigOverrides {
  /** Override the URL search string (mainly for tests / demos). */
  sessionSearch?: string;
  /** Human-readable label shown on the mode button in the study list. */
  displayName?: string;
  /** Default condition to apply when ?condition= is absent from the URL. */
  defaultCondition?: Condition;
}

function onModeEnter(
  args: OnModeEnterArgs,
  modeOpts: { modeConfiguration?: ModeConfigOverrides },
): void {
  const { servicesManager, extensionManager } = args;
  const cfg = modeOpts.modeConfiguration ?? {};

  // 1. Register a custom volume hanging protocol so the viewport is a
  //    VolumeViewport — required by the heatmap overlay (StackViewport
  //    does not support addVolumes / setVolumes).
  {
    const hpService = servicesManager.services?.hangingProtocolService;
    if (hpService && typeof hpService.addProtocol === 'function') {
      hpService.addProtocol(UNCERTAINTY_VOLUME_HP_ID, {
        id: UNCERTAINTY_VOLUME_HP_ID,
        locked: true,
        name: 'Uncertainty Review (Volume)',
        createdDate: '2025-01-01T00:00:00.000Z',
        modifiedDate: '2025-01-01T00:00:00.000Z',
        availableTo: {},
        editableBy: {},
        protocolMatchingRules: [],
        numberOfPriorsReferenced: 0,
        toolGroupIds: ['default'],
        displaySetSelectors: {
          defaultDisplaySetId: {
            seriesMatchingRules: [
              {
                attribute: 'numImageFrames',
                constraint: { greaterThan: { value: 0 } },
              },
              {
                attribute: 'isDisplaySetFromUrl',
                weight: 10,
                constraint: { equals: true },
              },
            ],
          },
        },
        stages: [
          {
            name: 'uncertainty-volume-stage',
            viewportStructure: {
              layoutType: 'grid',
              properties: { rows: 1, columns: 1 },
            },
            viewports: [
              {
                viewportOptions: {
                  viewportType: 'volume',
                  viewportId: 'uncertainty-volume-viewport',
                  toolGroupId: 'default',
                  orientation: 'axial',
                  initialImageOptions: { preset: 'middle' },
                },
                displaySets: [{ id: 'defaultDisplaySetId' }],
              },
            ],
          },
        ],
      });
    }
  }

  // 1. Parse session from URL — falls back to whatever the extension
  //    already parsed at preRegistration if the URL doesn't have one.
  const rawSearch = cfg.sessionSearch
    ?? getCurrentRouteSearch();
  const directLaunchSearch = ensureDefaultDirectLaunchSession(rawSearch, cfg.defaultCondition);
  const search = mergeStoredSessionIntoSearch(directLaunchSearch);
  const session = parseSessionFromSearch(search);
  const uncertaintyService: UncertaintyService =
    servicesManager.services.uncertaintyService;

  if (!uncertaintyService) {
    // eslint-disable-next-line no-console
    console.error(
      `[${MODE_ID}] uncertaintyService not registered. ` +
      'Make sure @thesis/extension-uncertainty is in the extensions list.',
    );
    return;
  }

  configureUncertaintyRuntimeDependencies({
    servicesManager,
    extensionManager,
  });

  if (session) {
    rememberSessionForRoute(session);
    uncertaintyService.setSession({
      reviewerId: session.reviewerId,
      condition: session.condition,
    });
    if (typeof document !== 'undefined') {
      document.title = describeSession(session) + ' — Uncertainty Review';
    }
  } else if (typeof window !== 'undefined') {
    // eslint-disable-next-line no-console
    console.warn(
      `[${MODE_ID}] No reviewer/condition in URL. ` +
      'Add ?reviewer=R03&condition=C2 (etc.) to enable session-scoped events.',
    );
  }

  // 2. Refresh the worklist on entry so the panel is populated by the
  //    time the user looks at it.
  const refreshResult = uncertaintyService.refreshWorklist();
  const refreshDone =
    refreshResult && typeof refreshResult.then === 'function'
      ? refreshResult.catch(() => undefined)
      : refreshResult && typeof refreshResult.catch === 'function'
        ? refreshResult.catch(() => undefined)
        : undefined;

  // 3. If the URL named an initial case, open it. If this mode was
  //    launched from the ordinary OHIF Study List, the URL usually only has
  //    StudyInstanceUIDs=...; after the worklist refresh, map that study UID
  //    back to the FastAPI case_id and make the route canonical.
  const hasStudySelection = getStudyInstanceUIDsFromSearch(search).length > 0;
  if (session?.initialCaseId || hasStudySelection) {
    const openInitialCase = () => {
      const items = uncertaintyService.getState().worklist.items;
      const explicit = session?.initialCaseId ?? null;
      const explicitIsRealCase = explicit
        ? items.some(it => it.case_id === explicit)
        : false;
      const inferred = inferCaseIdFromSelectedStudy(search, uncertaintyService);
      const caseId = explicitIsRealCase ? explicit : (inferred ?? explicit);

      if (!caseId) {
        // eslint-disable-next-line no-console
        console.warn(
          `[${MODE_ID}] Study List launch did not include caseId, and no ` +
          'worklist entry matched the selected StudyInstanceUIDs. Cannot auto-open.',
        );
        return;
      }

      updateCaseIdInUrl(caseId);
      uncertaintyService.selectCase?.({ caseId });
      void openUncertaintyCase(
        { caseId },
        buildOpenCaseHost({ servicesManager, extensionManager }),
      ).catch((err: Error) => {
        // eslint-disable-next-line no-console
        console.warn(`[${MODE_ID}] Initial case open failed:`, err);
      });
    };

    if (refreshDone && typeof refreshDone.then === 'function') {
      void refreshDone.then(openInitialCase);
    } else {
      openInitialCase();
    }
  }
}

interface OnModeExitArgs {
  servicesManager: AnyServices;
}

function onModeExit({ servicesManager }: OnModeExitArgs): void {
  const uncertaintyService: UncertaintyService | undefined =
    servicesManager.services?.uncertaintyService;
  if (!uncertaintyService) return;
  // Flush pending events synchronously via beacon — mirrors what the
  // EventLogger does on `pagehide`, but here we trigger it explicitly
  // so it also fires on intra-app navigation away from this mode.
  void uncertaintyService.closeCase();
}

// ---------------------------------------------------------------------------
// OHIF mode shape
// ---------------------------------------------------------------------------

function modeFactory({ modeConfiguration }: ModeFactoryArgs = {}) {
  // Derive display name and route from condition (or defaults).
  const condition = modeConfiguration?.defaultCondition ?? 'C2';
  const displayName = modeConfiguration?.displayName
    ?? CONDITION_DISPLAY_NAMES[condition]
    ?? 'Uncertainty-Guided Review';
  const routeSuffix = CONDITION_ROUTE_SUFFIXES[condition] ?? 'uncertainty-review';
  // Unique mode ID per condition so the study list shows three separate buttons.
  const modeId = condition === 'C2' ? MODE_ID : `${MODE_ID}-${condition.toLowerCase()}`;

  return {
    id: modeId,
    routeName: routeSuffix,
    displayName,

    /**
     * Determines whether a study is eligible for this mode. The installed
     * checkpoint and evaluation dataset are CT spleen specific.
     */
    isValidMode({ modalities }: { modalities: string }): { valid: boolean; description?: string } {
      const mods = (modalities ?? '').split('\\').map(s => s.trim());
      const ok = mods.some(m => m === 'CT');
      return ok
        ? { valid: true }
        : {
            valid: false,
            description: 'Uncertainty review requires a CT series.',
          };
    },

    onModeEnter(ctx: OnModeEnterArgs) {
      onModeEnter(ctx, { modeConfiguration });
    },
    onModeExit,

    routes: [
      {
        path: routeSuffix,
        layoutTemplate: () => ({
          id: '@ohif/extension-default.layoutTemplateModule.viewerLayout',
          props: {
            leftPanels: [
              `${EXTENSION_ID}.panelModule.worklist`,
            ],
            rightPanels: [
              SEGMENTATION_PANEL_WITH_TOOLS,
              MONAI_LABEL_PANEL,
              `${EXTENSION_ID}.panelModule.uncertainty`,
              `${EXTENSION_ID}.panelModule.submission`,
            ],
            viewports: [
              {
                namespace:
                  '@ohif/extension-cornerstone.viewportModule.cornerstone',
                displaySetsToDisplay: [
                  '@ohif/extension-default.sopClassHandlerModule.stack',
                ],
              },
              {
                namespace: SEGMENTATION_VIEWPORT,
                displaySetsToDisplay: [SEGMENTATION_SOP_CLASS_HANDLER],
              },
            ],
          },
        }),
      },
    ],

    extensions: extensionDependencies,

    hangingProtocol: UNCERTAINTY_VOLUME_HP_ID,

    sopClassHandlers: [
      '@ohif/extension-default.sopClassHandlerModule.stack',
      SEGMENTATION_SOP_CLASS_HANDLER,
    ],

    /**
     * Hotkeys.  Only one is essential ('u' = toggle heatmap); the
     * others are convenience for the user study and are intentionally
     * disabled in C0/C1 by the service-layer guard, so we can install
     * them in all conditions without leaking information.
     *
     * Spread the default OHIF hotkeys so that common operations
     * (e.g. Esc to cancel a measurement) are available in this mode.
     */
    hotkeys: [
      ...hotkeys.defaults.hotkeyBindings,
      { commandName: 'toggleUncertaintyHeatmap',
        label: 'Toggle uncertainty heatmap', keys: ['u'] },
      { commandName: 'acceptUncertaintyAnnotation',
        label: 'Accept current annotation', keys: ['a'] },
      { commandName: 'rejectUncertaintyAnnotation',
        label: 'Reject current annotation', keys: ['r'] },
      { commandName: 'refreshUncertaintyWorklist',
        label: 'Refresh worklist', keys: ['shift+u'] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Mode-level commands
//
// These complement the commands the extension already registers; the
// `openUncertaintyCase` command lives here because executing it
// requires OHIF host services the extension can't reach.
// ---------------------------------------------------------------------------

interface CommandsModuleArgs {
  servicesManager: AnyServices;
  commandsManager: AnyServices;
  extensionManager: AnyServices;
}

function getCommandsModule({
  servicesManager,
  extensionManager,
}: CommandsModuleArgs) {
  configureUncertaintyRuntimeDependencies({
    servicesManager,
    extensionManager,
  });

  const buildHost = (): OpenCaseHost =>
    buildOpenCaseHost({ servicesManager, extensionManager });

  return {
    definitions: {
      openUncertaintyCase: {
        commandName: 'openUncertaintyCase',
        commandFn: (args: { caseId: string }) =>
          openUncertaintyCase(args, buildHost()),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Default export — the OHIF mode manifest
// ---------------------------------------------------------------------------

const mode = {
  id: MODE_ID,
  modeFactory,
  extensionDependencies,
  getCommandsModule,
};

export default mode;
export { MODE_ID as id };
export { modeFactory };
export { getCommandsModule };
export {
  parseSessionFromSearch,
  describeSession,
} from './sessionConfig';
export {
  buildOpenPlan,
  executeOpen,
  type OpenCaseHost,
  type OpenPlan,
  type OpenPlanError,
} from './commands/openUncertaintyCase';
export { createCornerstoneAdapter } from './adapter/createCornerstoneAdapter';
export { createSegmentationExportAdapter } from './adapter/createSegmentationExportAdapter';
export { createSegmentationImportAdapter } from './adapter/createSegmentationImportAdapter';
