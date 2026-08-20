/**
 * CornerstoneAdapter implementation.
 *
 * Phase 4's `extension-uncertainty` declares a narrow `CornerstoneAdapter`
 * interface (see `extension-uncertainty/src/services/HeatmapRenderer.ts`)
 * and asks the host application to provide a concrete implementation.
 * This file is that implementation.
 *
 * The reason this code lives in the mode rather than the extension:
 *
 * This adapter targets Cornerstone3D V2 and V3.
 * Volume creation uses `createAndCacheDerivedVolume`.
 *
 * The whole file is wrapped in try/catch helpers because Cornerstone
 * sometimes throws on legitimate input states (e.g. setting transfer
 * functions on a viewport that hasn't finished its first render); we
 * log and degrade rather than crash the whole mode.
 */

import * as cornerstone from '@cornerstonejs/core';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';

import type { CornerstoneAdapter } from '@thesis/extension-uncertainty';

// ---------------------------------------------------------------------------
// Loose typings.
//
// We deliberately keep the OHIF/Cornerstone surface untyped at this layer:
// the types differ between versions, and the mode is here precisely to
// the variability between OHIF versions.  `unknown` and explicit `any` casts make the
// OHIF-bridging clear in code review.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyVolume = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyViewport = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRenderingEngine = any;

interface WritableScalarData {
  data: Float32Array;
  commit?: (data: Float32Array) => void;
}

function createTransferFunctions(transfer: Parameters<
  CornerstoneAdapter['applyTransferFunctions']
>[0]['transfer']) {
  const ctf = vtkColorTransferFunction.newInstance();
  for (const stop of transfer.color) {
    ctf.addRGBPoint(stop.x, stop.r, stop.g, stop.b);
  }
  const otf = vtkPiecewiseFunction.newInstance();
  for (const stop of transfer.opacity) {
    otf.addPoint(stop.x, stop.alpha);
  }
  return { ctf, otf };
}

function configureHeatmapActor(
  actor: AnyVolume,
  transfer: Parameters<CornerstoneAdapter['applyTransferFunctions']>[0]['transfer'],
  visible?: boolean,
): void {
  const property = actor?.getProperty?.();
  if (!property) {
    throw new Error('[CornerstoneAdapter] Heatmap volume actor has no property');
  }

  const { ctf, otf } = createTransferFunctions(transfer);
  property.setRGBTransferFunction(0, ctf);
  property.setScalarOpacity(0, otf);
  property.setInterpolationTypeToLinear?.();
  // Keep the uncertainty channel independent from the underlying CT.
  property.setIndependentComponents?.(true);
  if (visible !== undefined) {
    actor.setVisibility?.(visible);
  }
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface CornerstoneAdapterOptions {
  /**
   * Resolves the active rendering engine.  In OHIF this comes from
   * `cornerstoneViewportService.getRenderingEngine()` — the mode passes
   * a thunk so the adapter doesn't have to import OHIF services
   * directly (which would couple this code to a specific OHIF version).
   */
  getRenderingEngine: () => AnyRenderingEngine;
  /**
   * Resolves a Cornerstone3D viewport instance by ID.
   */
  getViewport: (viewportId: string) => AnyViewport | null;
}

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

export function createCornerstoneAdapter(
  opts: CornerstoneAdapterOptions,
): CornerstoneAdapter {
  return {
    async createDerivedScalarVolume(args) {
      // Cornerstone3D V2+ API: createAndCacheDerivedVolume copies the
      // reference geometry verbatim and only requires the scalar data.
      const vl: any = (cornerstone as any).volumeLoader;
      const cache: any = (cornerstone as any).cache;

      // Don't double-create — Cornerstone caches by ID.  Idempotency
      // is important because the OHIF mode may re-attach the same
      // case after a viewport remount.
      if (cache?.getVolume?.(args.volumeId)) {
        return args.volumeId;
      }

      const referenceVolume = cache?.getVolume?.(args.referenceVolumeId);
      if (!referenceVolume) {
        throw new Error(
          `[CornerstoneAdapter] Reference volume not in cache: ${args.referenceVolumeId}. ` +
          'The image volume must be loaded before the entropy overlay.',
        );
      }

      if (typeof vl.createAndCacheDerivedVolume !== 'function') {
        throw new Error(
          '[CornerstoneAdapter] Cornerstone volumeLoader does not expose ' +
          'createAndCacheDerivedVolume. Check your @cornerstonejs/core version (V2+ required).',
        );
      }

      const v = await vl.createAndCacheDerivedVolume(args.referenceVolumeId, {
        volumeId: args.volumeId,
        // float32 because predictive entropy is a floating-point quantity
        // and we don't want quantisation banding in the heatmap.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        targetBuffer: { type: 'Float32Array' as any },
      });
      // Copy the data in. Cornerstone3D V2 image-volume voxel managers
      // expose full-volume data through getCompleteScalarDataArray().
      const scalars = getWritableScalarData(v);
      if (scalars.data.length !== args.scalarData.length) {
        throw new Error(
          `[CornerstoneAdapter] Scalar length mismatch: derived volume has ` +
          `${scalars.data.length} voxels, entropy data has ${args.scalarData.length}.`,
        );
      }
      scalars.data.set(args.scalarData);
      scalars.commit?.(scalars.data);
      v.modified?.();
      return args.volumeId;
    },

    // -----------------------------------------------------------------

    async addVolumeToViewports({ volumeId, viewportIds, transfer, visible }) {
      for (const viewportId of viewportIds) {
        const viewport = opts.getViewport(viewportId);
        if (!viewport) continue;

        const heatmapInput = {
          volumeId,
          // Use an explicit actor UID so getActor(volumeId) remains stable
          // across supported Cornerstone versions.
          actorUID: volumeId,
          visibility: visible,
          callback: ({ volumeActor }: { volumeActor: AnyVolume }) => {
            configureHeatmapActor(volumeActor, transfer, visible);
          },
        };

        // The cleanest API across versions: setVolumes / addVolumes.
        // setVolumes replaces, addVolumes appends — we want append.
        if (typeof viewport.addVolumes === 'function') {
          await viewport.addVolumes([heatmapInput], true);
        } else if (typeof viewport.setVolumes === 'function') {
          // Read the current volumes, append, set.
          const existing: AnyVolume[] = (viewport.getVolumeIds?.() ?? [])
            .map((vid: string) => ({ volumeId: vid }));
          await viewport.setVolumes([...existing, heatmapInput], true);
        } else {
          // eslint-disable-next-line no-console
          console.warn(
            `[CornerstoneAdapter] viewport ${viewportId} exposes neither ` +
            'addVolumes nor setVolumes; skipping.',
          );
        }
      }
    },

    // -----------------------------------------------------------------

    applyTransferFunctions({ volumeId, viewportIds, transfer }) {
      for (const viewportId of viewportIds) {
        const viewport = opts.getViewport(viewportId);
        if (!viewport) continue;
        // Try primary lookup by volumeId first; fall back to iterating all
        // actors when the viewport was re-created (case switching) and the
        // actor is stored under a different UID.
        let actor: AnyVolume | null = null;
        const primaryEntry = viewport.getActor?.(volumeId);
        if (primaryEntry) {
          actor = primaryEntry?.actor ?? primaryEntry;
        } else {
          const allActors: AnyVolume[] = viewport.getActors?.() ?? [];
          for (const entry of allActors) {
            const candidate = entry?.actor ?? entry;
            if (candidate && typeof candidate.getProperty === 'function') {
              actor = candidate;
              break;
            }
          }
        }
        if (!actor || typeof actor.getProperty !== 'function') continue;

        try {
          configureHeatmapActor(actor, transfer);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[CornerstoneAdapter] Failed to apply transfer functions ` +
            `on ${viewportId} for ${volumeId}:`, err,
          );
        }
      }
    },

    // -----------------------------------------------------------------

    setVolumeVisible({ volumeId, viewportIds, visible }) {
      for (const viewportId of viewportIds) {
        const viewport = opts.getViewport(viewportId);
        if (!viewport) continue;
        // Try primary lookup by volumeId first; fall back to iterating all
        // actors when viewport was re-created (case switching).
        let actor: AnyVolume | null = null;
        const primaryEntry = viewport.getActor?.(volumeId);
        if (primaryEntry) {
          actor = primaryEntry?.actor ?? primaryEntry;
        } else {
          const allActors: AnyVolume[] = viewport.getActors?.() ?? [];
          for (const entry of allActors) {
            const candidate = entry?.actor ?? entry;
            if (candidate && typeof candidate.setVisibility === 'function') {
              actor = candidate;
              break;
            }
          }
        }
        if (!actor) continue;
        try {
          actor.setVisibility?.(visible);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[CornerstoneAdapter] Failed to set visibility on ${viewportId}:`,
            err,
          );
        }
      }
    },

    // -----------------------------------------------------------------

    async removeVolume({ volumeId, viewportIds }) {
      for (const viewportId of viewportIds) {
        const viewport = opts.getViewport(viewportId);
        if (!viewport) continue;
        try {
          // Preferred: removeVolumeActors([id]) on v2+.
          if (typeof viewport.removeVolumeActors === 'function') {
            viewport.removeVolumeActors([volumeId], false);
          } else if (typeof viewport.removeVolume === 'function') {
            viewport.removeVolume(volumeId);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[CornerstoneAdapter] removeVolume failed on ${viewportId}:`,
            err,
          );
        }
      }
      const cache: any = (cornerstone as any).cache;
      try {
        cache?.removeVolumeLoadObject?.(volumeId);
      } catch {
        // some versions only expose removeVolume
        cache?.removeVolume?.(volumeId);
      }
    },

    // -----------------------------------------------------------------

    renderViewports(viewportIds) {
      const re = opts.getRenderingEngine();
      if (!re) return;
      try {
        if (typeof re.renderViewports === 'function') {
          re.renderViewports(viewportIds);
        } else if (typeof re.render === 'function') {
          re.render();
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[CornerstoneAdapter] renderViewports failed:', err);
      }
    },
  };
}

function getWritableScalarData(volume: AnyVolume): WritableScalarData {
  const directData = tryGetScalarData(() => volume?.scalarData)
    ?? tryGetScalarData(() => volume?.getScalarData?.())
    ?? tryGetScalarData(() => volume?.voxelManager?.getScalarData?.())
    ?? tryGetScalarData(() => volume?.imageData?.getPointData?.()?.getScalars?.()?.getData?.());

  if (directData) {
    return { data: directData };
  }

  const voxelManager = volume?.voxelManager;
  const completeData = tryGetScalarData(() => voxelManager?.getCompleteScalarDataArray?.());
  if (completeData) {
    return {
      data: completeData,
      commit: data => voxelManager.setCompleteScalarDataArray?.(data),
    };
  }

  throw new Error('[CornerstoneAdapter] Derived volume has no scalar buffer');
}

function tryGetScalarData(read: () => Float32Array | undefined): Float32Array | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
