/**
 * SegmentationImportAdapter implementation.
 *
 * This is the C1 bridge: after the external MONAILabel/FastAPI
 * service returns a `segmentation_url`, the mode imports that mask as an
 * editable Cornerstone3D V2/OHIF labelmap.  The extension deliberately knows only
 * about the small `SegmentationImportAdapter` contract; this file is the
 * OHIF-host-specific implementation.
 *
 * MONAILabel is assumed to run outside this repository.  The adapter does not
 * import or depend on the bundled `extensions/monai-label` folder.  It only
 * consumes the HTTP payload returned by the uncertainty service.
 */

import * as cornerstone from '@cornerstonejs/core';
import * as cstoneTools from '@cornerstonejs/tools';

import {
  loadNiftiFromUrl,
  type NiftiVolume,
  type SegmentationImportAdapter,
} from '@thesis/extension-uncertainty';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

type ScalarLabelData = Uint8Array | Uint16Array | Int16Array | Int32Array | Float32Array;

interface WritableScalarLabelData {
  data: ScalarLabelData;
  commit?: (data: ScalarLabelData) => void;
}

export interface SegmentationImportAdapterOptions {
  /** OHIF servicesManager, used when available for segmentationService/toolGroupService. */
  servicesManager?: Any;
  /** Testable fetch implementation; defaults to global fetch through loadNiftiFromUrl. */
  fetchImpl?: typeof fetch;
}

const SEGMENTATION_ID_PREFIX = 'uncertainty:monailabel-seg';
const SEGMENTATION_VOLUME_ID_PREFIX = 'uncertainty:monailabel-mask';

export function createSegmentationImportAdapter(
  opts: SegmentationImportAdapterOptions = {},
): SegmentationImportAdapter {
  return {
    async importSegmentation(args) {
      if (!args.viewportIds.length) {
        throw new Error('no active viewport ids were provided for AI mask import');
      }

      const segmentationId = `${SEGMENTATION_ID_PREFIX}:${args.caseId}`;
      const segmentationVolumeId = `${SEGMENTATION_VOLUME_ID_PREFIX}:${args.caseId}`;

      await removeExistingSegmentation({
        segmentationId,
        segmentationVolumeId,
        viewportIds: args.viewportIds,
        servicesManager: opts.servicesManager,
      });

      let nifti: NiftiVolume;
      try {
        nifti = await loadNiftiFromUrl(args.segmentationUrl, opts.fetchImpl);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[SegmentationImportAdapter] Cannot fetch MONAILabel AI mask from ${args.segmentationUrl}: ${message}. ` +
          'If that URL contains a Docker-only host such as monai-label, return the mask through the uncertainty-service proxy or set PUBLIC_UNCERTAINTY_SERVICE_URL/PUBLIC_MONAI_LABEL_URL to a browser-reachable URL.',
        );
      }
      const labelmapVolume = await createDerivedLabelmapVolume({
        referenceVolumeId: args.referenceVolumeId,
        segmentationVolumeId,
        servicesManager: opts.servicesManager,
      });
      const target = getWritableScalarData(labelmapVolume);
      copyNiftiLabelsIntoTarget(nifti, target.data);
      target.commit?.(target.data);
      labelmapVolume.modified?.();

      const segmentIndices = getSegmentIndices(target.data);
      const representationType = getLabelmapRepresentationType();

      await registerSegmentation({
        segmentationId,
        segmentationVolumeId,
        referenceVolumeId: args.referenceVolumeId,
        representationType,
        label: args.label ?? `MONAILabel AI mask · ${args.caseId}`,
        segmentIndices,
        servicesManager: opts.servicesManager,
      });

      await attachSegmentationToViewports({
        segmentationId,
        representationType,
        viewportIds: args.viewportIds,
        servicesManager: opts.servicesManager,
      });

      renderViewports(args.viewportIds, opts.servicesManager);
      return { segmentationId };
    },

    async removeSegmentation({ segmentationId, viewportIds }) {
      const segmentationVolumeId = segmentationId.replace(
        SEGMENTATION_ID_PREFIX,
        SEGMENTATION_VOLUME_ID_PREFIX,
      );
      await removeExistingSegmentation({
        segmentationId,
        segmentationVolumeId,
        viewportIds,
        servicesManager: opts.servicesManager,
      });
      renderViewports(viewportIds, opts.servicesManager);
    },
  };
}

// ---------------------------------------------------------------------------
// Volume creation and voxel transfer
// ---------------------------------------------------------------------------

async function createDerivedLabelmapVolume(args: {
  referenceVolumeId: string;
  segmentationVolumeId: string;
  servicesManager?: Any;
}): Promise<Any> {
  const vl: Any = (cornerstone as Any).volumeLoader;
  const cache: Any = (cornerstone as Any).cache;

  const cached = cache?.getVolume?.(args.segmentationVolumeId);
  if (cached) return cached;

  const referenceVolume = cache?.getVolume?.(args.referenceVolumeId)
    ?? await createAndLoadReferenceVolume({
      referenceVolumeId: args.referenceVolumeId,
      servicesManager: args.servicesManager,
    });
  if (!referenceVolume) {
    throw new Error(
      `[SegmentationImportAdapter] Reference volume not in cache: ${args.referenceVolumeId}. ` +
      'Load the DICOM volume before importing the MONAILabel mask.',
    );
  }

  const targetBuffer = { type: 'Uint8Array' as const };

  if (typeof vl?.createAndCacheDerivedLabelmapVolume === 'function') {
    return vl.createAndCacheDerivedLabelmapVolume(args.referenceVolumeId, {
      volumeId: args.segmentationVolumeId,
      targetBuffer,
    });
  }

  throw new Error(
    '[SegmentationImportAdapter] Cornerstone3D V2 createAndCacheDerivedLabelmapVolume ' +
    'is required. Check your @cornerstonejs/core version.',
  );
}

async function createAndLoadReferenceVolume(args: {
  referenceVolumeId: string;
  servicesManager?: Any;
}): Promise<Any | null> {
  const vl: Any = (cornerstone as Any).volumeLoader;
  const cache: Any = (cornerstone as Any).cache;
  if (typeof vl?.createAndCacheVolume !== 'function') return null;

  const imageIds = getImageIdsForReferenceVolume(
    args.referenceVolumeId,
    args.servicesManager,
  );
  if (!imageIds.length) return null;

  const volume = await Promise.resolve(
    vl.createAndCacheVolume(args.referenceVolumeId, { imageIds }),
  );
  await Promise.resolve(volume?.load?.());
  return cache?.getVolume?.(args.referenceVolumeId) ?? volume ?? null;
}

function getImageIdsForReferenceVolume(
  referenceVolumeId: string,
  servicesManager?: Any,
): string[] {
  const displaySetUID = referenceVolumeId.split(':').pop();
  if (!displaySetUID) return [];

  const displaySets = getDisplaySets(servicesManager?.services?.displaySetService);
  const match = displaySets.find(ds =>
    ds?.displaySetInstanceUID === displaySetUID
    || ds?.DisplaySetInstanceUID === displaySetUID
    || ds?.displaySetUID === displaySetUID
    || ds?.id === displaySetUID
    || ds?.uid === displaySetUID,
  );
  if (!match) return [];

  return getImageIds(match);
}

function getDisplaySets(displaySetService?: Any): Any[] {
  const candidates: Any[] = [];
  const addMany = (value: Any): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      candidates.push(...value);
      return;
    }
    if (value instanceof Map) {
      candidates.push(...Array.from(value.values()));
      return;
    }
    if (typeof value === 'object') {
      candidates.push(...Object.values(value));
    }
  };

  addMany(displaySetService?.getActiveDisplaySets?.());
  addMany(displaySetService?.getDisplaySets?.());
  addMany(displaySetService?.activeDisplaySets);
  addMany(displaySetService?.displaySets);
  addMany(displaySetService?._displaySets);

  return Array.from(new Set(candidates.filter(Boolean)));
}

function getImageIds(displaySet: Any): string[] {
  const direct = displaySet?.imageIds;
  if (Array.isArray(direct)) {
    return direct.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }

  const images = displaySet?.images;
  if (Array.isArray(images)) {
    return images
      .map(image => image?.imageId ?? image?.imageIdForURI)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
  }

  return [];
}

function getScalarData(volume: Any, throwOnMissing = true): ScalarLabelData {
  const data = tryGetScalarData(() => volume?.getScalarData?.())
    ?? volume?.scalarData
    ?? tryGetScalarData(() => volume?.voxelManager?.getScalarData?.())
    ?? tryGetScalarData(() => volume?.imageData?.getPointData?.()?.getScalars?.()?.getData?.());
  if (!data && throwOnMissing) {
    throw new Error('[SegmentationImportAdapter] Derived labelmap volume has no scalar buffer.');
  }
  return data as ScalarLabelData;
}

function tryGetScalarData(read: () => ScalarLabelData | undefined): ScalarLabelData | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function getWritableScalarData(volume: Any): WritableScalarLabelData {
  const data = getScalarData(volume, false);
  if (data) {
    return { data };
  }

  const voxelManager = volume?.voxelManager;
  const completeScalarData = voxelManager?.getCompleteScalarDataArray?.();
  if (completeScalarData) {
    return {
      data: completeScalarData as ScalarLabelData,
      commit: writableData => voxelManager.setCompleteScalarDataArray?.(writableData),
    };
  }

  throw new Error('[SegmentationImportAdapter] Derived labelmap volume has no scalar buffer.');
}

function copyNiftiLabelsIntoTarget(nifti: NiftiVolume, target: ScalarLabelData): void {
  if (target.length !== nifti.data.length) {
    throw new Error(
      `[SegmentationImportAdapter] AI mask voxel length mismatch: ` +
      `Cornerstone labelmap has ${target.length}, NIfTI has ${nifti.data.length}. ` +
      'Confirm MONAILabel returned a mask in the same grid as the loaded series.',
    );
  }

  for (let i = 0; i < target.length; i++) {
    const label = Math.round(Number(nifti.data[i]));
    target[i] = Number.isFinite(label) && label > 0 ? label : 0;
  }
}

function getSegmentIndices(data: ScalarLabelData): number[] {
  const indices = new Set<number>();
  for (let i = 0; i < data.length; i++) {
    const value = Math.round(Number(data[i]));
    if (value > 0) indices.add(value);
  }
  return Array.from(indices).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Cornerstone/OHIF segmentation state bridging
// ---------------------------------------------------------------------------

function getLabelmapRepresentationType(): string {
  const enums = (cstoneTools as Any)?.Enums?.SegmentationRepresentations ?? {};
  return enums.Labelmap ?? enums.LABELMAP ?? 'Labelmap';
}

async function registerSegmentation(args: {
  segmentationId: string;
  segmentationVolumeId: string;
  referenceVolumeId: string;
  representationType: string;
  label: string;
  segmentIndices: number[];
  servicesManager?: Any;
}): Promise<void> {
  const segmentation = buildSegmentationDescriptor(args);
  const svc = args.servicesManager?.services?.segmentationService;

  if (typeof svc?.addOrUpdateSegmentation === 'function') {
    await Promise.resolve(svc.addOrUpdateSegmentation(segmentation));
    return;
  }

  if (typeof svc?.addSegmentation === 'function') {
    await Promise.resolve(svc.addSegmentation(segmentation));
    return;
  }

  const toolsSegmentation = (cstoneTools as Any)?.segmentation;
  if (typeof toolsSegmentation?.addSegmentations === 'function') {
    await Promise.resolve(toolsSegmentation.addSegmentations([segmentation]));
    return;
  }

  throw new Error(
    '[SegmentationImportAdapter] No Cornerstone3D V2 API to register ' +
    'the imported MONAILabel segmentation.',
  );
}

function buildSegmentationDescriptor(args: {
  segmentationId: string;
  segmentationVolumeId: string;
  referenceVolumeId: string;
  representationType: string;
  label: string;
  segmentIndices: number[];
}): Any {
  const labelmapData = {
    volumeId: args.segmentationVolumeId,
    referencedVolumeId: args.referenceVolumeId,
  };
  const representationData = {
    [args.representationType]: labelmapData,
    Labelmap: labelmapData,
    LABELMAP: labelmapData,
  };

  const firstSegmentIndex = args.segmentIndices[0] ?? 1;
  const segments = buildSegments(args.segmentIndices);

  return {
    id: args.segmentationId,
    segmentationId: args.segmentationId,
    label: args.label,
    type: args.representationType,
    representation: {
      type: args.representationType,
      data: labelmapData,
    },
    representationData,
    segments,
    activeSegmentIndex: firstSegmentIndex,
    segmentCount: args.segmentIndices.length,
    segmentsLocked: [],
    cachedStats: {},
    displayText: [],
    // OHIF deliberately hides non-hydrated segmentations from its panel and
    // active-segmentation APIs.  The imported volume is fully materialised at
    // this point, so mark it hydrated to expose the normal brush/erase UI.
    hydrated: true,
    isActive: true,
    isVisible: true,
  };
}

function buildSegments(indices: number[]): Any[] {
  const max = Math.max(0, ...indices);
  const segments: Any[] = Array.from({ length: max + 1 }, (_, i) => ({
    segmentIndex: i,
    label: i === 0 ? 'Background' : `AI Segment ${i}`,
    color: i === 0 ? [0, 0, 0] : [255, 0, 0],
    opacity: 255,
    isVisible: true,
    isLocked: false,
    displayText: [],
    cachedStats: {},
  }));
  if (segments.length === 1) {
    segments.push({
      segmentIndex: 1,
      label: 'AI Segment 1',
      color: [255, 0, 0],
      opacity: 255,
      isVisible: true,
      isLocked: false,
      displayText: [],
      cachedStats: {},
    });
  }
  return segments;
}

async function attachSegmentationToViewports(args: {
  segmentationId: string;
  representationType: string;
  viewportIds: string[];
  servicesManager?: Any;
}): Promise<void> {
  const toolsSegmentation = (cstoneTools as Any)?.segmentation;

  // Preferred modern path: viewport-centric mapping.
  if (typeof toolsSegmentation?.addLabelmapRepresentationToViewportMap === 'function') {
    const viewportMap = Object.fromEntries(
      args.viewportIds.map(viewportId => [
        viewportId,
        [{ segmentationId: args.segmentationId, type: args.representationType }],
      ]),
    );
    await Promise.resolve(
      toolsSegmentation.addLabelmapRepresentationToViewportMap(viewportMap),
    );
    return;
  }

  // Modern path in newer v3/v4 docs: add one or more representations per viewport.
  if (typeof toolsSegmentation?.addSegmentationRepresentations === 'function') {
    let attachedAtLeastOneViewport = false;
    for (const viewportId of args.viewportIds) {
      try {
        await Promise.resolve(toolsSegmentation.addSegmentationRepresentations(
          viewportId,
          [{ segmentationId: args.segmentationId, type: args.representationType }],
        ));
        attachedAtLeastOneViewport = true;
      } catch {
        // Older Cornerstone uses toolGroupId, not viewportId.  Fall through below.
      }
    }
    if (attachedAtLeastOneViewport) return;
  }

  const toolGroupIds = getToolGroupIdsForViewports(args.viewportIds, args.servicesManager);
  const svc = args.servicesManager?.services?.segmentationService;

  for (const toolGroupId of toolGroupIds) {
    if (typeof svc?.addSegmentationRepresentationToToolGroup === 'function') {
      await Promise.resolve(svc.addSegmentationRepresentationToToolGroup(
        toolGroupId,
        args.segmentationId,
        args.representationType,
      ));
      continue;
    }
    if (typeof toolsSegmentation?.addSegmentationRepresentations === 'function') {
      await Promise.resolve(toolsSegmentation.addSegmentationRepresentations(
        toolGroupId,
        [{ segmentationId: args.segmentationId, type: args.representationType }],
      ));
    }
  }
}

function getToolGroupIdsForViewports(viewportIds: string[], servicesManager?: Any): string[] {
  const svc = servicesManager?.services?.toolGroupService;
  const ids = new Set<string>();

  for (const viewportId of viewportIds) {
    const group = svc?.getToolGroupForViewport?.(viewportId)
      ?? svc?.getToolGroupForViewportId?.(viewportId);
    const id = group?.id ?? group?.toolGroupId;
    if (typeof id === 'string') ids.add(id);
  }

  const all = svc?.getToolGroupIds?.();
  if (Array.isArray(all)) {
    for (const id of all) if (typeof id === 'string') ids.add(id);
  }

  return Array.from(ids);
}

// ---------------------------------------------------------------------------
// Cleanup and rendering
// ---------------------------------------------------------------------------

async function removeExistingSegmentation(args: {
  segmentationId: string;
  segmentationVolumeId: string;
  viewportIds: string[];
  servicesManager?: Any;
}): Promise<void> {
  const toolsSegmentation = (cstoneTools as Any)?.segmentation;
  const svc = args.servicesManager?.services?.segmentationService;

  for (const viewportId of args.viewportIds) {
    try {
      await Promise.resolve(toolsSegmentation?.removeSegmentationRepresentation?.(
        viewportId,
        args.segmentationId,
      ));
    } catch {
      // ignore cleanup drift across Cornerstone versions
    }
  }

  try { await Promise.resolve(svc?.removeSegmentation?.(args.segmentationId)); } catch { /* noop */ }
  try { await Promise.resolve(toolsSegmentation?.removeSegmentation?.(args.segmentationId)); } catch { /* noop */ }
  try { await Promise.resolve(toolsSegmentation?.state?.removeSegmentation?.(args.segmentationId)); } catch { /* noop */ }

  const cache: Any = (cornerstone as Any).cache;
  try { cache?.removeVolumeLoadObject?.(args.segmentationVolumeId); } catch { /* noop */ }
  try { cache?.removeVolume?.(args.segmentationVolumeId); } catch { /* noop */ }
}

function renderViewports(viewportIds: string[], servicesManager?: Any): void {
  const csv = servicesManager?.services?.cornerstoneViewportService;
  const renderingEngine = csv?.getRenderingEngine?.();

  if (typeof renderingEngine?.renderViewports === 'function') {
    renderingEngine.renderViewports(viewportIds);
    return;
  }

  for (const viewportId of viewportIds) {
    const viewport = csv?.getCornerstoneViewport?.(viewportId);
    viewport?.render?.();
  }
}
