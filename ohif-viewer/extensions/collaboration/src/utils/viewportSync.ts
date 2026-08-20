/**
 * viewportSync.ts
 * 
 * Viewport synchronization utilities for real-time collaboration
 * Handles capturing presenter viewport state and applying it to followers
 * 
 * Location: extensions/collaboration/src/utils/viewportSync.ts
 */

import { getRenderingEngine } from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/core';

// ============================================
// Type Definitions
// ============================================

export interface SerializedViewportState {
  viewportId: string;
  renderingEngineId: string;
  type: 'stack' | 'volume';
  // Camera state (for volume viewports)
  camera?: {
    position: [number, number, number];
    focalPoint: [number, number, number];
    viewUp: [number, number, number];
    parallelScale?: number;
    viewAngle?: number;
  };
  // Stack viewport specific
  imageIndex?: number;
  // Display settings
  voi?: {
    windowWidth: number;
    windowCenter: number;
  };
  invert?: boolean;
  rotation?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  // Pan/Zoom
  pan?: [number, number];
  zoom?: number;
  // Display area
  displayArea?: {
    imageArea: [number, number];
    imageCanvasPoint: { imagePoint: [number, number]; canvasPoint: [number, number] };
    storeAsInitialCamera: boolean;
  };
  // Timestamp for ordering
  timestamp?: number;
}

// ============================================
// Capture Viewport State (Presenter)
// ============================================

/**
 * Captures the current state of a viewport for synchronization
 */
export function captureViewportState(
  viewportId: string,
  renderingEngineId: string = 'myRenderingEngine'
): SerializedViewportState | null {
  try {
    const renderingEngine = getRenderingEngine(renderingEngineId);
    if (!renderingEngine) {
      console.warn(`[viewportSync] Rendering engine ${renderingEngineId} not found`);
      return null;
    }

    const viewport = renderingEngine.getViewport(viewportId);
    if (!viewport) {
      console.warn(`[viewportSync] Viewport ${viewportId} not found`);
      return null;
    }

    const state: SerializedViewportState = {
      viewportId,
      renderingEngineId,
      type: viewport.type as 'stack' | 'volume',
      timestamp: Date.now(),
    };

    // Get camera state
    const camera = viewport.getCamera();
    if (camera) {
      state.camera = {
        position: camera.position as [number, number, number],
        focalPoint: camera.focalPoint as [number, number, number],
        viewUp: camera.viewUp as [number, number, number],
        parallelScale: camera.parallelScale,
        viewAngle: camera.viewAngle,
      };
    }

    // Get VOI (Window/Level)
    const voiRange = viewport.getProperties()?.voiRange;
    if (voiRange) {
      const windowWidth = voiRange.upper - voiRange.lower;
      const windowCenter = voiRange.lower + windowWidth / 2;
      state.voi = { windowWidth, windowCenter };
    }

    // Get other properties
    const properties = viewport.getProperties();
    if (properties) {
      state.invert = properties.invert;
      state.rotation = properties.rotation;
    }

    // For stack viewports, get current image index
    if (viewport.type === 'stack') {
      const stackViewport = viewport as Types.IStackViewport;
      state.imageIndex = stackViewport.getCurrentImageIdIndex();
    }

    // Get zoom
    state.zoom = viewport.getZoom();

    // Get pan
    state.pan = viewport.getPan() as [number, number];

    return state;
  } catch (error) {
    console.error('[viewportSync] Error capturing viewport state:', error);
    return null;
  }
}

// ============================================
// Apply Viewport State (Follower)
// ============================================

/**
 * Applies a serialized viewport state to synchronize with presenter
 */
export function applyViewportState(
  state: SerializedViewportState,
  targetViewportId?: string,
  renderingEngineId: string = 'myRenderingEngine'
): boolean {
  try {
    const renderingEngine = getRenderingEngine(renderingEngineId);
    if (!renderingEngine) {
      console.warn(`[viewportSync] Rendering engine ${renderingEngineId} not found`);
      return false;
    }

    // Use target viewport ID or fall back to the one in state
    const viewportId = targetViewportId || state.viewportId;
    const viewport = renderingEngine.getViewport(viewportId);
    
    if (!viewport) {
      console.warn(`[viewportSync] Viewport ${viewportId} not found`);
      return false;
    }

    // Apply camera state
    if (state.camera) {
      viewport.setCamera({
        position: state.camera.position,
        focalPoint: state.camera.focalPoint,
        viewUp: state.camera.viewUp,
        parallelScale: state.camera.parallelScale,
        viewAngle: state.camera.viewAngle,
      });
    }

    // Apply VOI (Window/Level)
    if (state.voi) {
      const lower = state.voi.windowCenter - state.voi.windowWidth / 2;
      const upper = state.voi.windowCenter + state.voi.windowWidth / 2;
      viewport.setProperties({
        voiRange: { lower, upper },
      });
    }

    // Apply other properties
    if (state.invert !== undefined || state.rotation !== undefined) {
      viewport.setProperties({
        invert: state.invert,
        rotation: state.rotation,
      });
    }

    // For stack viewports, set image index
    if (viewport.type === 'stack' && state.imageIndex !== undefined) {
      const stackViewport = viewport as Types.IStackViewport;
      const currentIndex = stackViewport.getCurrentImageIdIndex();
      if (currentIndex !== state.imageIndex) {
        stackViewport.setImageIdIndex(state.imageIndex);
      }
    }

    // Apply zoom
    if (state.zoom !== undefined) {
      viewport.setZoom(state.zoom);
    }

    // Apply pan
    if (state.pan) {
      viewport.setPan(state.pan);
    }

    // Render the changes
    viewport.render();

    return true;
  } catch (error) {
    console.error('[viewportSync] Error applying viewport state:', error);
    return false;
  }
}

// ============================================
// Viewport Change Listener Setup
// ============================================

/**
 * Sets up listeners for viewport changes to broadcast to collaboration
 */
export function setupViewportChangeListeners(
  viewportId: string,
  renderingEngineId: string,
  onViewportChange: (state: SerializedViewportState) => void,
  options: { throttleMs?: number } = {}
): () => void {
  const { throttleMs = 100 } = options;
  
  let lastBroadcast = 0;
  let pendingBroadcast: NodeJS.Timeout | null = null;

  const handleViewportChange = () => {
    const now = Date.now();
    
    // Throttle broadcasts
    if (now - lastBroadcast < throttleMs) {
      // Schedule a delayed broadcast if not already scheduled
      if (!pendingBroadcast) {
        pendingBroadcast = setTimeout(() => {
          pendingBroadcast = null;
          const state = captureViewportState(viewportId, renderingEngineId);
          if (state) {
            lastBroadcast = Date.now();
            onViewportChange(state);
          }
        }, throttleMs - (now - lastBroadcast));
      }
      return;
    }

    const state = captureViewportState(viewportId, renderingEngineId);
    if (state) {
      lastBroadcast = now;
      onViewportChange(state);
    }
  };

  // Get the viewport element
  const renderingEngine = getRenderingEngine(renderingEngineId);
  if (!renderingEngine) {
    console.warn('[viewportSync] Cannot setup listeners: rendering engine not found');
    return () => {};
  }

  const viewport = renderingEngine.getViewport(viewportId);
  if (!viewport) {
    console.warn('[viewportSync] Cannot setup listeners: viewport not found');
    return () => {};
  }

  const element = viewport.element;
  if (!element) {
    console.warn('[viewportSync] Cannot setup listeners: viewport element not found');
    return () => {};
  }

  // Listen for Cornerstone events
  const events = [
    'CORNERSTONE_CAMERA_MODIFIED',
    'CORNERSTONE_VOI_MODIFIED', 
    'CORNERSTONE_STACK_SCROLL',
    'CORNERSTONE_IMAGE_RENDERED',
  ];

  // Also listen for generic cornerstone events
  const cornerstoneEvents = [
    'cornerstonecameramodified',
    'cornerstonevoimodified',
    'cornerstonestackscroll',
  ];

  const allEvents = [...events, ...cornerstoneEvents];

  allEvents.forEach(eventName => {
    element.addEventListener(eventName.toLowerCase(), handleViewportChange);
  });

  // Cleanup function
  return () => {
    if (pendingBroadcast) {
      clearTimeout(pendingBroadcast);
    }
    allEvents.forEach(eventName => {
      element.removeEventListener(eventName.toLowerCase(), handleViewportChange);
    });
  };
}

// ============================================
// Helper: Get Active Viewport Info
// ============================================

export function getActiveViewportInfo(servicesManager: any): {
  viewportId: string;
  renderingEngineId: string;
} | null {
  try {
    const { viewportGridService, cornerstoneViewportService } = servicesManager.services;
    
    const activeViewportId = viewportGridService?.getActiveViewportId?.();
    if (!activeViewportId) {
      return null;
    }

    // Try to get rendering engine ID from cornerstone service
    const renderingEngineId = cornerstoneViewportService?.getRenderingEngine?.()?.id || 'myRenderingEngine';

    return {
      viewportId: activeViewportId,
      renderingEngineId,
    };
  } catch (error) {
    console.error('[viewportSync] Error getting active viewport info:', error);
    return null;
  }
}

export default {
  captureViewportState,
  applyViewportState,
  setupViewportChangeListeners,
  getActiveViewportInfo,
};
