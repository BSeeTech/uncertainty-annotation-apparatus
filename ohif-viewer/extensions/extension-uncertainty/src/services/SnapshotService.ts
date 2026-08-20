/**
 * SnapshotService — periodic segmentation state recording.
 *
 * Captures time-locked snapshots of the active segmentation at regular
 * intervals and at every significant event (tool switch, zoom, region
 * change).  This creates a temporal trace that allows post-hoc analysis
 * of edit reversions, trust trajectories, and automation bias.
 *
 * Usage:
 *   const snapshots = new SnapshotService(eventLogger, getViewportInfo, getVoxelCount, getComponentCount);
 *   snapshots.start();   // begins 5-second interval sampling
 *   snapshots.stop();    // clean up on mode unmount
 *
 * Snapshots are emitted as events with type "snapshot" through the
 * existing EventLogger, so they appear alongside case_open, slice_change,
 * submit etc. in the per-reviewer event timeline.
 */

import type { EventLogger } from './EventLogger';

/** Number of seconds between automatic snapshots. */
const SNAPSHOT_INTERVAL_SEC = 5;

export interface SegmentationSnapshot {
  /** ISO-8601 timestamp of the snapshot. */
  ts: string;
  /** Number of voxels/ pixels in the segmentation mask (0 = none). */
  voxelCount: number;
  /** Number of separate connected components. */
  componentCount: number;
  /** Viewport slice position at time of capture. */
  sliceIndex: number;
  /** Current tool being used. */
  activeTool: string | null;
  /** Zoom level. */
  zoom: number;
  /** Pan offset. */
  pan: { x: number; y: number };
}

export class SnapshotService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private _lastSnapshot: SegmentationSnapshot | null = null;

  constructor(
    private readonly eventLogger: EventLogger,
    private readonly getViewportInfo: () => {
      sliceIndex: number;
      activeTool: string | null;
      zoom: number;
      pan: { x: number; y: number };
    },
    private readonly getVoxelCount: () => number,
    private readonly getComponentCount: () => number,
  ) {}

  /** Start periodic snapshot recording. */
  start(): void {
    if (this.intervalId !== null) return;
    this.captureNow(); // immediate first capture
    this.intervalId = setInterval(() => this.captureNow(), SNAPSHOT_INTERVAL_SEC * 1000);
  }

  /** Stop periodic snapshot recording. */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Final snapshot on stop
    this.captureNow();
  }

  /** Capture a single snapshot and emit it as an event. */
  captureNow(): void {
    try {
      const vp = this.getViewportInfo();
      const voxelCount = this.getVoxelCount();
      const componentCount = this.getComponentCount();

      const snapshot: SegmentationSnapshot = {
        ts: new Date().toISOString(),
        voxelCount,
        componentCount,
        sliceIndex: vp.sliceIndex,
        activeTool: vp.activeTool,
        zoom: vp.zoom,
        pan: vp.pan,
      };

      // Avoid emitting identical snapshots (no change since last capture)
      if (this._lastSnapshot) {
        const last = this._lastSnapshot;
        if (
          last.voxelCount === snapshot.voxelCount &&
          last.componentCount === snapshot.componentCount &&
          last.sliceIndex === snapshot.sliceIndex &&
          last.activeTool === snapshot.activeTool
        ) {
          return; // no meaningful change — skip
        }
      }

      this._lastSnapshot = snapshot;
      this.eventLogger.log('snapshot', { snapshot });
    } catch {
      // Silently ignore snapshot failures — they should never crash the viewer
    }
  }

  /** Expose the last snapshot for analysis scripts. */
  get lastSnapshot(): SegmentationSnapshot | null {
    return this._lastSnapshot;
  }
}
