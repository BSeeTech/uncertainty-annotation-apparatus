/**
 * HeatmapRenderer
 *
 * The Cornerstone3D-facing service that owns the lifecycle of the
 * uncertainty volume actor:
 *
 *   1. Loads the entropy NIfTI from a URL produced by the FastAPI
 *      uncertainty service.
 *   2. Registers it as a Cornerstone3D `Volume` whose frame of
 *      reference is copied verbatim from the underlying image volume,
 *      so the heatmap stays slice-aligned across pan/zoom/window/level.
 *   3. Adds it as a second volume actor in the same viewport(s) as the
 *      image, applies a sequential colormap and an opacity ramp.
 *   4. Exposes idempotent `setVisible` / `setOpacity` / `unload`
 *      operations so the panel components can drive the rendering
 *      from React state.
 *
 * Because Cornerstone3D's API surface is large and version-sensitive
 * across OHIF v3.7 → v3.10, this class touches it through a deliberately
 * narrow interface (`CornerstoneAdapter`).  The adapter is provided by
 * the OHIF-facing `index.tsx` at extension-init time; tests pass a
 * stub that records calls and never opens a WebGL context.  This
 * isolation is what allows the Cornerstone3D dependency to upgrade
 * without rewriting the renderer.
 */

import {
  DEFAULT_HEATMAP_CONFIG,
  type HeatmapConfig,
} from '../types';
import { loadNiftiFromUrl, type NiftiVolume } from '../utils/loadNifti';
import {
  buildTransferFunctions,
  OPACITY_PERCEPTUAL_POWER,
  type TransferFunctions,
} from '../utils/transferFunctions';

const ENTROPY_VOLUME_ID_PREFIX = 'uncertainty:entropy';

/**
 * Minimal adapter over the Cornerstone3D APIs we depend on.  Keeping
 * this interface stable lets the implementation in index.tsx upgrade
 * Cornerstone independently of the renderer logic.
 */
export interface CornerstoneAdapter {
  /**
   * Build a Cornerstone3D volume from raw scalar data using the
   * geometry of an existing reference volume.  Returns the new volume
   * ID.
   */
  createDerivedScalarVolume(args: {
    volumeId: string;
    referenceVolumeId: string;
    scalarData: Float32Array;
    /** Same geometry as referenceVolume; passed for assertion / debug. */
    dimensions: [number, number, number];
    spacing: [number, number, number];
  }): Promise<string>;

  /**
   * Add and configure a volume actor in one operation. Cornerstone invokes the
   * adapter's actor callback during creation, which prevents an initially
   * hidden actor from racing the later transfer-function/visibility updates.
   */
  addVolumeToViewports(args: {
    volumeId: string;
    viewportIds: string[];
    transfer: TransferFunctions;
    visible: boolean;
  }): Promise<void>;

  /** Apply color + opacity transfer functions to a volume actor. */
  applyTransferFunctions(args: {
    volumeId: string;
    viewportIds: string[];
    transfer: TransferFunctions;
  }): void;

  /** Show / hide a volume actor without removing it. */
  setVolumeVisible(args: {
    volumeId: string;
    viewportIds: string[];
    visible: boolean;
  }): void;

  /** Remove a volume from the cache and from viewports. */
  removeVolume(args: {
    volumeId: string;
    viewportIds: string[];
  }): Promise<void>;

  /** Request a re-render of the listed viewports. */
  renderViewports(viewportIds: string[]): void;
}

export interface HeatmapRendererOptions {
  adapter: CornerstoneAdapter;
  /**
   * Optional fetch override (mainly for tests).  Defaults to the
   * global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

interface LoadedHeatmap {
  caseId: string;
  sourceUrl: string;
  volumeId: string;
  viewportIds: string[];
  niftiVolume: NiftiVolume;
  config: HeatmapConfig;
}

export class HeatmapRenderer {
  private readonly adapter: CornerstoneAdapter;
  private readonly fetchImpl: typeof fetch;
  private current: LoadedHeatmap | null = null;

  constructor(opts: HeatmapRendererOptions) {
    this.adapter = opts.adapter;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Currently loaded case, if any.  Useful for tests and for the panel
   * component's "now showing X" indicator.
   */
  get currentCaseId(): string | null {
    return this.current?.caseId ?? null;
  }

  get currentConfig(): HeatmapConfig | null {
    return this.current?.config ?? null;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  /**
   * Load the heatmap for `caseId` from `entropyUrl` and attach it to
   * `viewportIds`.  Replaces any previously loaded heatmap.
   *
   * @returns the empirical max entropy of the volume, useful for the
   *          panel to display a "ln(K) = …" label.
   */
  async loadForCase(args: {
    caseId: string;
    entropyUrl: string;
    referenceVolumeId: string;
    viewportIds: string[];
    initialConfig?: Partial<HeatmapConfig>;
  }): Promise<{ maxEntropy: number; nVoxels: number }> {
    // Tear down any previous heatmap so we don't leak volume actors or
    // accidentally keep an old C2 uncertainty.nii.gz in Cornerstone cache when
    // the same case is rerun. The source URL is versioned by the backend, but
    // replacing the volume actor is the safest visible-cache reset.
    if (this.current) {
      await this.unload();
    }

    const niftiVolume = await loadNiftiFromUrl(args.entropyUrl, this.fetchImpl);

    // Brief delay to let the viewport finish its initial render before we
    // attach the heatmap overlay. Without this, adding a derived scalar
    // volume immediately after the CT volume has loaded can cause
    // Cornerstone to re-initialize the viewport, producing a black frame
    // that persists.
    await new Promise(resolve => setTimeout(resolve, 100));

    const config: HeatmapConfig = {
      ...DEFAULT_HEATMAP_CONFIG,
      // If the volume's empirical max is sensibly below ln(K) for
      // binary, prefer it as the upper bound so the colormap uses the
      // full dynamic range.  The caller can still override.
      maxEntropy: args.initialConfig?.maxEntropy
        ?? Math.max(niftiVolume.dataMax, DEFAULT_HEATMAP_CONFIG.maxEntropy * 0.5),
      opacity: args.initialConfig?.opacity ?? DEFAULT_HEATMAP_CONFIG.opacity,
      visible: args.initialConfig?.visible ?? DEFAULT_HEATMAP_CONFIG.visible,
    };

    const volumeId = `${ENTROPY_VOLUME_ID_PREFIX}:${args.caseId}`;
    await this.adapter.createDerivedScalarVolume({
      volumeId,
      referenceVolumeId: args.referenceVolumeId,
      scalarData: niftiVolume.data,
      dimensions: niftiVolume.dimensions,
      spacing: niftiVolume.spacing,
    });

    const transfer = buildTransferFunctions({
      maxEntropy: config.maxEntropy,
      baseOpacity: Math.pow(config.opacity, OPACITY_PERCEPTUAL_POWER),
    });

    await this.adapter.addVolumeToViewports({
      volumeId,
      viewportIds: args.viewportIds,
      transfer,
      visible: config.visible,
    });
    this.adapter.renderViewports(args.viewportIds);

    this.current = {
      caseId: args.caseId,
      sourceUrl: args.entropyUrl,
      volumeId,
      viewportIds: args.viewportIds,
      niftiVolume,
      config,
    };

    return {
      maxEntropy: niftiVolume.dataMax,
      nVoxels: niftiVolume.data.length,
    };
  }

  // -------------------------------------------------------------------
  // Live controls
  // -------------------------------------------------------------------

  setVisible(visible: boolean): void {
    if (!this.current) return;
    this.current.config = { ...this.current.config, visible };
    this.adapter.setVolumeVisible({
      volumeId: this.current.volumeId,
      viewportIds: this.current.viewportIds,
      visible,
    });
    this.adapter.renderViewports(this.current.viewportIds);
  }

  setOpacity(opacity: number): void {
    if (!this.current) return;
    const clamped = Math.max(0, Math.min(1, opacity));
    const perceptual = Math.pow(clamped, OPACITY_PERCEPTUAL_POWER);
    this.current.config = { ...this.current.config, opacity: perceptual };

    const transfer = buildTransferFunctions({
      maxEntropy: this.current.config.maxEntropy,
      baseOpacity: perceptual,
    });
    this.adapter.applyTransferFunctions({
      volumeId: this.current.volumeId,
      viewportIds: this.current.viewportIds,
      transfer,
    });
    this.adapter.renderViewports(this.current.viewportIds);
  }

  setMaxEntropy(maxEntropy: number): void {
    if (!this.current) return;
    if (maxEntropy <= 0) {
      throw new Error(`maxEntropy must be > 0, got ${maxEntropy}`);
    }
    this.current.config = { ...this.current.config, maxEntropy };
    const transfer = buildTransferFunctions({
      maxEntropy,
      baseOpacity: this.current.config.opacity,
    });
    this.adapter.applyTransferFunctions({
      volumeId: this.current.volumeId,
      viewportIds: this.current.viewportIds,
      transfer,
    });
    this.adapter.renderViewports(this.current.viewportIds);
  }

  async unload(): Promise<void> {
    if (!this.current) return;
    const { volumeId, viewportIds } = this.current;
    this.current = null;
    await this.adapter.removeVolume({ volumeId, viewportIds });
    this.adapter.renderViewports(viewportIds);
  }
}
