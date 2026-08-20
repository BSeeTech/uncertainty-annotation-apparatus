/**
 * annotationSync.ts
 * 
 * Annotation synchronization utilities for real-time collaboration
 * Handles capturing, broadcasting, and applying annotation changes
 * 
 * Location: extensions/collaboration/src/utils/annotationSync.ts
 */

import { annotation as csAnnotation } from '@cornerstonejs/tools';

// ============================================
// Type Definitions
// ============================================

export interface SerializedAnnotation {
  annotationUID: string;
  toolName: string;
  data: {
    handles?: any;
    text?: string;
    cachedStats?: any;
    [key: string]: any;
  };
  metadata: {
    referencedImageId?: string;
    toolName: string;
    FrameOfReferenceUID?: string;
    viewPlaneNormal?: [number, number, number];
    viewUp?: [number, number, number];
    [key: string]: any;
  };
  isLocked?: boolean;
  isVisible?: boolean;
}

// ============================================
// Serialize Annotation for Network
// ============================================

/**
 * Serializes a Cornerstone annotation for network transmission
 */
export function serializeAnnotation(annotation: any): SerializedAnnotation | null {
  try {
    if (!annotation || !annotation.annotationUID) {
      return null;
    }

    return {
      annotationUID: annotation.annotationUID,
      toolName: annotation.metadata?.toolName || 'Unknown',
      data: {
        handles: annotation.data?.handles ? JSON.parse(JSON.stringify(annotation.data.handles)) : undefined,
        text: annotation.data?.text,
        cachedStats: annotation.data?.cachedStats,
        ...annotation.data,
      },
      metadata: {
        ...annotation.metadata,
      },
      isLocked: annotation.isLocked,
      isVisible: annotation.isVisible,
    };
  } catch (error) {
    console.error('[annotationSync] Error serializing annotation:', error);
    return null;
  }
}

// ============================================
// Apply Remote Annotation
// ============================================

/**
 * Applies a remote annotation received from collaboration
 */
export function applyRemoteAnnotation(
  serializedAnnotation: SerializedAnnotation,
  servicesManager: any
): boolean {
  try {
    const { annotationUID, toolName, data, metadata } = serializedAnnotation;

    // Check if annotation already exists
    const existingAnnotation = csAnnotation.state.getAnnotation(annotationUID);
    
    if (existingAnnotation) {
      // Update existing annotation
      Object.assign(existingAnnotation.data, data);
      Object.assign(existingAnnotation.metadata, metadata);
      
      if (serializedAnnotation.isLocked !== undefined) {
        existingAnnotation.isLocked = serializedAnnotation.isLocked;
      }
      if (serializedAnnotation.isVisible !== undefined) {
        existingAnnotation.isVisible = serializedAnnotation.isVisible;
      }

      // Trigger re-render
      triggerAnnotationRender(servicesManager);
      
      console.log(`[annotationSync] Updated annotation: ${annotationUID}`);
      return true;
    }

    // Create new annotation
    const newAnnotation = {
      annotationUID,
      data: { ...data },
      metadata: { ...metadata, toolName },
      isLocked: serializedAnnotation.isLocked || false,
      isVisible: serializedAnnotation.isVisible !== false,
      invalidated: true,
    };

    // Add to annotation state
    const frameOfReferenceUID = metadata.FrameOfReferenceUID;
    if (frameOfReferenceUID) {
      csAnnotation.state.addAnnotation(newAnnotation, frameOfReferenceUID);
      
      // Trigger re-render
      triggerAnnotationRender(servicesManager);
      
      console.log(`[annotationSync] Added new annotation: ${annotationUID}`);
      return true;
    } else {
      console.warn(`[annotationSync] No FrameOfReferenceUID for annotation: ${annotationUID}`);
      return false;
    }
  } catch (error) {
    console.error('[annotationSync] Error applying remote annotation:', error);
    return false;
  }
}

// ============================================
// Remove Remote Annotation
// ============================================

/**
 * Removes an annotation that was deleted remotely
 */
export function removeRemoteAnnotation(
  annotationUID: string,
  servicesManager: any
): boolean {
  try {
    const annotation = csAnnotation.state.getAnnotation(annotationUID);
    
    if (!annotation) {
      console.warn(`[annotationSync] Annotation not found for removal: ${annotationUID}`);
      return false;
    }

    const frameOfReferenceUID = annotation.metadata?.FrameOfReferenceUID;
    
    if (frameOfReferenceUID) {
      csAnnotation.state.removeAnnotation(annotationUID);
      
      // Trigger re-render
      triggerAnnotationRender(servicesManager);
      
      console.log(`[annotationSync] Removed annotation: ${annotationUID}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error('[annotationSync] Error removing annotation:', error);
    return false;
  }
}

// ============================================
// Modify Remote Annotation
// ============================================

/**
 * Applies modifications to an existing annotation
 */
export function modifyRemoteAnnotation(
  annotationUID: string,
  changes: Partial<SerializedAnnotation>,
  servicesManager: any
): boolean {
  try {
    const annotation = csAnnotation.state.getAnnotation(annotationUID);
    
    if (!annotation) {
      console.warn(`[annotationSync] Annotation not found for modification: ${annotationUID}`);
      return false;
    }

    // Apply changes
    if (changes.data) {
      Object.assign(annotation.data, changes.data);
    }
    if (changes.metadata) {
      Object.assign(annotation.metadata, changes.metadata);
    }
    if (changes.isLocked !== undefined) {
      annotation.isLocked = changes.isLocked;
    }
    if (changes.isVisible !== undefined) {
      annotation.isVisible = changes.isVisible;
    }

    // Mark as invalidated to trigger recalculation
    annotation.invalidated = true;

    // Trigger re-render
    triggerAnnotationRender(servicesManager);
    
    console.log(`[annotationSync] Modified annotation: ${annotationUID}`);
    return true;
  } catch (error) {
    console.error('[annotationSync] Error modifying annotation:', error);
    return false;
  }
}

// ============================================
// Setup Annotation Event Listeners
// ============================================

/**
 * Sets up listeners for annotation changes to broadcast to collaboration
 */
export function setupAnnotationChangeListeners(
  onAnnotationAdded: (annotation: SerializedAnnotation) => void,
  onAnnotationModified: (annotationUID: string, changes: Partial<SerializedAnnotation>) => void,
  onAnnotationDeleted: (annotationUID: string) => void
): () => void {
  
  const handleAnnotationAdded = (event: any) => {
    const { annotation } = event.detail || {};
    if (annotation) {
      const serialized = serializeAnnotation(annotation);
      if (serialized) {
        onAnnotationAdded(serialized);
      }
    }
  };

  const handleAnnotationModified = (event: any) => {
    const { annotation } = event.detail || {};
    if (annotation) {
      const serialized = serializeAnnotation(annotation);
      if (serialized) {
        onAnnotationModified(annotation.annotationUID, {
          data: serialized.data,
          metadata: serialized.metadata,
        });
      }
    }
  };

  const handleAnnotationRemoved = (event: any) => {
    const { annotationUID } = event.detail || {};
    if (annotationUID) {
      onAnnotationDeleted(annotationUID);
    }
  };

  // Subscribe to Cornerstone Tools annotation events
  const eventTarget = csAnnotation.eventTarget || document;
  
  eventTarget.addEventListener('ANNOTATION_ADDED', handleAnnotationAdded);
  eventTarget.addEventListener('ANNOTATION_MODIFIED', handleAnnotationModified);
  eventTarget.addEventListener('ANNOTATION_REMOVED', handleAnnotationRemoved);
  
  // Also try lowercase versions
  eventTarget.addEventListener('annotationadded', handleAnnotationAdded);
  eventTarget.addEventListener('annotationmodified', handleAnnotationModified);
  eventTarget.addEventListener('annotationremoved', handleAnnotationRemoved);

  // Cleanup function
  return () => {
    eventTarget.removeEventListener('ANNOTATION_ADDED', handleAnnotationAdded);
    eventTarget.removeEventListener('ANNOTATION_MODIFIED', handleAnnotationModified);
    eventTarget.removeEventListener('ANNOTATION_REMOVED', handleAnnotationRemoved);
    eventTarget.removeEventListener('annotationadded', handleAnnotationAdded);
    eventTarget.removeEventListener('annotationmodified', handleAnnotationModified);
    eventTarget.removeEventListener('annotationremoved', handleAnnotationRemoved);
  };
}

// ============================================
// Helper: Trigger Viewport Re-render
// ============================================

function triggerAnnotationRender(servicesManager: any): void {
  try {
    const { cornerstoneViewportService } = servicesManager?.services || {};
    
    if (cornerstoneViewportService) {
      // Get all viewports and render them
      const renderingEngine = cornerstoneViewportService.getRenderingEngine?.();
      if (renderingEngine) {
        renderingEngine.render();
        return;
      }
    }

    // Fallback: try to get rendering engine directly
    const { getRenderingEngines } = require('@cornerstonejs/core');
    const engines = getRenderingEngines();
    engines.forEach((engine: any) => {
      engine.render();
    });
  } catch (error) {
    console.warn('[annotationSync] Could not trigger render:', error);
  }
}

// ============================================
// Load Session Annotations
// ============================================

/**
 * Loads all annotations from a session state
 */
export function loadSessionAnnotations(
  annotations: SerializedAnnotation[],
  servicesManager: any
): number {
  let loadedCount = 0;
  
  for (const annotation of annotations) {
    if (applyRemoteAnnotation(annotation, servicesManager)) {
      loadedCount++;
    }
  }
  
  console.log(`[annotationSync] Loaded ${loadedCount}/${annotations.length} annotations from session`);
  return loadedCount;
}

export default {
  serializeAnnotation,
  applyRemoteAnnotation,
  removeRemoteAnnotation,
  modifyRemoteAnnotation,
  setupAnnotationChangeListeners,
  loadSessionAnnotations,
};
