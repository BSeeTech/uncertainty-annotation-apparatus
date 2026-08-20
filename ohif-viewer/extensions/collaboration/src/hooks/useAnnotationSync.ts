/**
 * useAnnotationSync.ts
 * 
 * React hook for real-time annotation/measurement synchronization in collaboration sessions.
 * Uses OHIF's MeasurementService to capture annotation events.
 * 
 * Location: extensions/collaboration/src/hooks/useAnnotationSync.ts
 */

import { useEffect, useRef, useCallback } from 'react';

interface UseAnnotationSyncProps {
  collaborationService: any;
  servicesManager: any;
  isEnabled: boolean;
  role: 'presenter' | 'follower';
  sessionId: string | null;
}

/**
 * Hook for synchronizing measurements/annotations between collaboration participants
 */
export function useAnnotationSync({
  collaborationService,
  servicesManager,
  isEnabled,
  role,
  sessionId,
}: UseAnnotationSyncProps) {
  const isProcessingRemoteRef = useRef(false);
  const pendingMeasurementsRef = useRef<Set<string>>(new Set());
  const subscriptionsRef = useRef<Array<{ unsubscribe: () => void }>>([]);
  const lastBroadcastTimeRef = useRef<Map<string, number>>(new Map());
  const completedAnnotationsRef = useRef<Set<string>>(new Set());

  // Throttle broadcasts - only send every 100ms per annotation during drawing
  const BROADCAST_THROTTLE_MS = 100;

  // Get MeasurementService from servicesManager
  const getMeasurementService = useCallback(() => {
    return servicesManager?.services?.measurementService;
  }, [servicesManager]);

  // Serialize measurement for transmission - include full annotation data
  const serializeMeasurement = useCallback((measurement: any) => {
    if (!measurement) return null;

    try {
      // Get the actual annotation from Cornerstone
      const csTools = (window as any).cornerstoneTools;
      const manager = csTools?.annotation?.state?.getAnnotationManager?.();
      let cornerstoneAnnotation = null;
      
      if (manager) {
        try {
          cornerstoneAnnotation = manager.getAnnotation(measurement.uid);
        } catch (e) {
          // Annotation might not exist yet
        }
      }

      // EARLY CHECK: For ArrowAnnotate, don't serialize if incomplete
      if (measurement.toolName === 'ArrowAnnotate') {
        const points = cornerstoneAnnotation?.data?.handles?.points || measurement.points;
        const hasDistinctPoints = points && points.length >= 2 && 
          (Math.abs(points[0][0] - points[1][0]) > 0.001 || Math.abs(points[0][1] - points[1][1]) > 0.001);
        const hasRealText = !!(cornerstoneAnnotation?.data?.text || measurement.label);
        
        if (!hasDistinctPoints || !hasRealText) {
          console.log('[AnnotationSync] Skipping serialization - ArrowAnnotate incomplete:', {
            hasDistinctPoints,
            hasRealText,
            dataText: cornerstoneAnnotation?.data?.text,
            label: measurement.label
          });
          return null; // Don't serialize incomplete ArrowAnnotate
        }
      }

      // Deep clone the cornerstone annotation data to capture everything
      let fullAnnotationData = null;
      if (cornerstoneAnnotation) {
        try {
          fullAnnotationData = JSON.parse(JSON.stringify({
            annotationUID: cornerstoneAnnotation.annotationUID,
            data: cornerstoneAnnotation.data,  // Includes handles, text, cachedStats, etc.
            metadata: cornerstoneAnnotation.metadata,
            isLocked: cornerstoneAnnotation.isLocked,
            isVisible: cornerstoneAnnotation.isVisible,
          }));
          
          // For ArrowAnnotate, get text from the CORRECT sources (not displayText!)
          if (measurement.toolName === 'ArrowAnnotate') {
            // Priority: data.text > measurement.label > data.label
            // DO NOT use displayText as fallback - it contains slice info like "(S: 0)"
            const actualText = 
              cornerstoneAnnotation.data?.text ||
              measurement.label ||
              cornerstoneAnnotation.data?.label ||
              '';
            
            if (fullAnnotationData.data) {
              fullAnnotationData.data.text = actualText;
            }
            
            // Log FULL annotation structure for debugging
            console.log('[AnnotationSync] FULL ArrowAnnotate annotation:', JSON.stringify(cornerstoneAnnotation, null, 2));
            console.log('[AnnotationSync] FULL measurement object:', JSON.stringify(measurement, null, 2));
          }
        } catch (e) {
          console.warn('[AnnotationSync] Failed to deep clone annotation:', e);
        }
      }

      const serialized = {
        uid: measurement.uid,
        SOPInstanceUID: measurement.SOPInstanceUID,
        FrameOfReferenceUID: measurement.FrameOfReferenceUID,
        referenceSeriesUID: measurement.referenceSeriesUID,
        referenceStudyUID: measurement.referenceStudyUID,
        label: measurement.label,
        description: measurement.description,
        type: measurement.type,
        unit: measurement.unit,
        points: measurement.points,
        textBox: measurement.textBox,
        toolName: measurement.toolName,
        displayText: measurement.displayText,
        // Include the full deep-cloned Cornerstone annotation
        cornerstoneAnnotation: fullAnnotationData,
      };

      // Log what we're sending for debugging
      if (measurement.toolName === 'ArrowAnnotate') {
        console.log('[AnnotationSync] Serializing ArrowAnnotate:', {
          uid: measurement.uid,
          csAnnotationText: fullAnnotationData?.data?.text,
          measurementLabel: measurement.label,
          displayText: measurement.displayText,
          handlesCount: fullAnnotationData?.data?.handles?.points?.length,
          handlesPoints: fullAnnotationData?.data?.handles?.points,
          hasAnnotation: !!fullAnnotationData,
          dataKeys: fullAnnotationData?.data ? Object.keys(fullAnnotationData.data) : [],
        });
        // CRITICAL: Log the EXACT data being transmitted
        console.log('[AnnotationSync] TRANSMITTING csAnnotation.data:', JSON.stringify(fullAnnotationData?.data, null, 2));
      }

      return serialized;
    } catch (e) {
      console.error('[AnnotationSync] Failed to serialize measurement:', e);
      return null;
    }
  }, []);

  // Apply remote measurement - create actual Cornerstone annotation
  const applyRemoteMeasurement = useCallback((measurementData: any) => {
    if (!measurementData?.uid) return;

    // Skip if we're already processing this
    if (pendingMeasurementsRef.current.has(measurementData.uid)) {
      return;
    }

    isProcessingRemoteRef.current = true;
    pendingMeasurementsRef.current.add(measurementData.uid);

    try {
      const csTools = (window as any).cornerstoneTools;
      const manager = csTools?.annotation?.state?.getAnnotationManager?.();
      
      if (!manager) {
        console.warn('[AnnotationSync] Annotation manager not available');
        return;
      }

      // Check if annotation already exists
      let existingAnnotation = null;
      try {
        existingAnnotation = manager.getAnnotation(measurementData.uid);
      } catch (e) {
        // Doesn't exist
      }

      if (existingAnnotation) {
        // Update existing annotation - deep merge the data
        if (measurementData.cornerstoneAnnotation?.data) {
          // Preserve the complete data structure including text, handles, textBox
          existingAnnotation.data = JSON.parse(JSON.stringify(measurementData.cornerstoneAnnotation.data));
        }
        existingAnnotation.invalidated = true;
        console.log('[AnnotationSync] Updated existing annotation:', measurementData.uid);
      } else {
        // Create new annotation from the Cornerstone data
        const csAnnotation = measurementData.cornerstoneAnnotation;
        
        // Debug: log what we received
        if (measurementData.toolName === 'ArrowAnnotate') {
          console.log('[AnnotationSync] Received ArrowAnnotate:', {
            uid: measurementData.uid,
            hasCSAnnotation: !!csAnnotation,
            text: csAnnotation?.data?.text,
            label: measurementData.label,
            displayText: measurementData.displayText,
            handlesCount: csAnnotation?.data?.handles?.points?.length,
            arrowFirst: csAnnotation?.data?.handles?.arrowFirst,
            dataKeys: csAnnotation?.data ? Object.keys(csAnnotation.data) : [],
          });
        }
        
        if (csAnnotation) {
          // Deep clone to avoid reference issues - preserve EVERYTHING
          const newAnnotation = {
            annotationUID: csAnnotation.annotationUID || measurementData.uid,
            // Deep clone data to preserve all nested objects (handles, textBox, etc.)
            data: JSON.parse(JSON.stringify(csAnnotation.data || {})),
            // Deep clone metadata to preserve viewPlaneNormal, viewUp
            metadata: JSON.parse(JSON.stringify(csAnnotation.metadata || {
              toolName: measurementData.toolName || 'Length',
              FrameOfReferenceUID: measurementData.FrameOfReferenceUID,
              referencedImageId: measurementData.SOPInstanceUID,
            })),
            isLocked: csAnnotation.isLocked ?? false,
            isVisible: csAnnotation.isVisible ?? true,
            invalidated: true,
            highlighted: false,
          };

          // Ensure handles exist with proper structure
          if (!newAnnotation.data.handles) {
            newAnnotation.data.handles = {
              points: measurementData.points || [],
              activeHandleIndex: null,
              textBox: measurementData.textBox || { hasMoved: false },
            };
          }

          // For ArrowAnnotate, ensure all required fields are set
          if (measurementData.toolName === 'ArrowAnnotate') {
            // Ensure arrowFirst is set (defaults to true)
            if (newAnnotation.data.handles.arrowFirst === undefined) {
              newAnnotation.data.handles.arrowFirst = true;
            }
            
            // Log final annotation being created
            console.log('[AnnotationSync] Creating ArrowAnnotate with:', {
              text: newAnnotation.data.text,
              arrowFirst: newAnnotation.data.handles.arrowFirst,
              pointsCount: newAnnotation.data.handles.points?.length,
              hasTextBox: !!newAnnotation.data.handles.textBox,
            });
          }

          manager.addAnnotation(newAnnotation);
          console.log('[AnnotationSync] Created new annotation:', newAnnotation.annotationUID, 'tool:', newAnnotation.metadata?.toolName);
        } else if (measurementData.points?.length > 0) {
          // Fallback: create annotation from measurement points
          const newAnnotation = {
            annotationUID: measurementData.uid,
            data: {
              handles: {
                points: measurementData.points,
                activeHandleIndex: null,
                textBox: measurementData.textBox || { hasMoved: false },
                arrowFirst: true,
              },
              text: measurementData.label || '',
              cachedStats: {},
            },
            metadata: {
              toolName: measurementData.toolName || 'Length',
              FrameOfReferenceUID: measurementData.FrameOfReferenceUID,
              referencedImageId: measurementData.SOPInstanceUID,
              viewPlaneNormal: [0, 0, 1],
              viewUp: [0, -1, 0],
            },
            isLocked: false,
            isVisible: true,
            invalidated: true,
            highlighted: false,
          };

          manager.addAnnotation(newAnnotation);
          console.log('[AnnotationSync] Created annotation from points:', newAnnotation.annotationUID);
        }
      }

      // Trigger viewport render
      const cs = (window as any).cornerstone;
      if (cs?.getRenderingEngines) {
        const engines = cs.getRenderingEngines();
        engines.forEach((engine: any) => {
          engine.render();
        });
      }

    } catch (e) {
      console.error('[AnnotationSync] Failed to apply remote measurement:', e);
    } finally {
      setTimeout(() => {
        isProcessingRemoteRef.current = false;
        pendingMeasurementsRef.current.delete(measurementData.uid);
      }, 50);
    }
  }, []);

  // Remove measurement
  const removeMeasurement = useCallback((uid: string) => {
    isProcessingRemoteRef.current = true;

    try {
      // Remove from Cornerstone annotation manager
      const csTools = (window as any).cornerstoneTools;
      const manager = csTools?.annotation?.state?.getAnnotationManager?.();
      if (manager) {
        try {
          manager.removeAnnotation(uid);
        } catch (e) {
          // Annotation might not exist
        }
      }

      // Also remove from OHIF MeasurementService
      const measurementService = getMeasurementService();
      if (measurementService) {
        try {
          measurementService.remove(uid);
        } catch (e) {
          // Measurement might not exist
        }
      }

      // Trigger render
      const cs = (window as any).cornerstone;
      if (cs?.getRenderingEngines) {
        const engines = cs.getRenderingEngines();
        engines.forEach((engine: any) => engine.render());
      }

      console.log('[AnnotationSync] Removed measurement:', uid);
    } catch (e) {
      console.error('[AnnotationSync] Failed to remove measurement:', e);
    } finally {
      setTimeout(() => {
        isProcessingRemoteRef.current = false;
      }, 50);
    }
  }, [getMeasurementService]);

  // Subscribe to OHIF MeasurementService events
  useEffect(() => {
    if (!isEnabled || !collaborationService || !sessionId || !servicesManager) {
      return;
    }

    const measurementService = getMeasurementService();
    if (!measurementService) {
      console.warn('[AnnotationSync] MeasurementService not available');
      return;
    }

    console.log('[AnnotationSync] Setting up measurement sync via MeasurementService...');

    // Helper to check if ArrowAnnotate is complete (has distinct points and text entered)
    const isArrowAnnotateComplete = (measurement: any, csAnnotation: any): boolean => {
      if (measurement.toolName !== 'ArrowAnnotate') return true;
      
      const points = csAnnotation?.data?.handles?.points || measurement.points;
      if (!points || points.length < 2) return false;
      
      // Check if points are distinct (not the same starting point)
      const p0 = points[0];
      const p1 = points[1];
      if (Math.abs(p0[0] - p1[0]) < 0.001 && Math.abs(p0[1] - p1[1]) < 0.001) {
        return false; // Points are the same - still drawing
      }
      
      // Check if text has been entered
      // IMPORTANT: Only check data.text and measurement.label - NOT displayText!
      const hasRealText = !!(csAnnotation?.data?.text || measurement.label);
      
      console.log('[AnnotationSync] ArrowAnnotate completeness check:', {
        hasDistinctPoints: true,
        dataText: csAnnotation?.data?.text,
        measurementLabel: measurement.label,
        hasRealText,
      });
      
      return hasRealText;
    };

    // Handler for measurement added (completed annotation)
    const handleMeasurementAdded = (event: any) => {
      if (isProcessingRemoteRef.current) return;
      
      const measurement = event?.measurement || event;
      if (!measurement?.uid) return;
      if (pendingMeasurementsRef.current.has(measurement.uid)) return;

      // Get the actual Cornerstone annotation for completeness check
      const csTools = (window as any).cornerstoneTools;
      const manager = csTools?.annotation?.state?.getAnnotationManager?.();
      let csAnnotation = null;
      if (manager) {
        try {
          csAnnotation = manager.getAnnotation(measurement.uid);
        } catch (e) {}
      }

      // For ArrowAnnotate, wait until it's complete (has text and distinct points)
      if (!isArrowAnnotateComplete(measurement, csAnnotation)) {
        console.log('[AnnotationSync] ArrowAnnotate not complete yet, waiting for update...');
        return;
      }

      // Mark as completed - this is the final state
      completedAnnotationsRef.current.add(measurement.uid);

      const serialized = serializeMeasurement(measurement);
      if (!serialized) return;

      console.log('[AnnotationSync] Broadcasting completed measurement:', serialized.uid, serialized.toolName);
      collaborationService.broadcastAnnotationAdded(serialized);
    };

    // Handler for measurement updated (during drawing or editing)
    const handleMeasurementUpdated = (event: any) => {
      if (isProcessingRemoteRef.current) return;

      const measurement = event?.measurement || event;
      if (!measurement?.uid) return;
      if (pendingMeasurementsRef.current.has(measurement.uid)) return;

      // Get the actual Cornerstone annotation for completeness check
      const csTools = (window as any).cornerstoneTools;
      const manager = csTools?.annotation?.state?.getAnnotationManager?.();
      let csAnnotation = null;
      if (manager) {
        try {
          csAnnotation = manager.getAnnotation(measurement.uid);
        } catch (e) {}
      }

      // If this is a completed ArrowAnnotate that we haven't broadcast yet, do it now
      if (measurement.toolName === 'ArrowAnnotate' && 
          !completedAnnotationsRef.current.has(measurement.uid) &&
          isArrowAnnotateComplete(measurement, csAnnotation)) {
        
        completedAnnotationsRef.current.add(measurement.uid);
        const serialized = serializeMeasurement(measurement);
        if (serialized) {
          console.log('[AnnotationSync] Broadcasting completed ArrowAnnotate (from update):', serialized.uid);
          collaborationService.broadcastAnnotationAdded(serialized);
        }
        return;
      }

      // Skip updates for completed annotations (only send the final ADDED event)
      if (completedAnnotationsRef.current.has(measurement.uid)) {
        return;
      }

      // Throttle updates during drawing
      const now = Date.now();
      const lastBroadcast = lastBroadcastTimeRef.current.get(measurement.uid) || 0;
      if (now - lastBroadcast < BROADCAST_THROTTLE_MS) {
        return;
      }
      lastBroadcastTimeRef.current.set(measurement.uid, now);

      const serialized = serializeMeasurement(measurement);
      if (!serialized) return;

      // Send as modification (intermediate state)
      collaborationService.broadcastAnnotationModified(measurement.uid, serialized);
    };

    // Handler for measurement removed
    const handleMeasurementRemoved = (event: any) => {
      if (isProcessingRemoteRef.current) return;

      const uid = event?.uid || event?.measurement?.uid || event?.measurementUID;
      if (!uid) return;

      // Clean up tracking
      completedAnnotationsRef.current.delete(uid);
      lastBroadcastTimeRef.current.delete(uid);

      console.log('[AnnotationSync] Broadcasting measurement removal:', uid);
      collaborationService.broadcastAnnotationDeleted(uid);
    };

    // Subscribe to MeasurementService events
    const events = measurementService.EVENTS;
    
    if (events) {
      console.log('[AnnotationSync] Available MeasurementService events:', Object.keys(events));

      const subs: Array<{ unsubscribe: () => void }> = [];

      // MEASUREMENT_ADDED - when annotation is completed
      if (events.MEASUREMENT_ADDED) {
        const sub = measurementService.subscribe(
          events.MEASUREMENT_ADDED,
          handleMeasurementAdded
        );
        if (sub) subs.push(sub);
        console.log('[AnnotationSync] Subscribed to MEASUREMENT_ADDED');
      }

      // MEASUREMENT_UPDATED - during drawing (throttled)
      if (events.MEASUREMENT_UPDATED) {
        const sub = measurementService.subscribe(
          events.MEASUREMENT_UPDATED,
          handleMeasurementUpdated
        );
        if (sub) subs.push(sub);
        console.log('[AnnotationSync] Subscribed to MEASUREMENT_UPDATED');
      }

      // MEASUREMENT_REMOVED
      if (events.MEASUREMENT_REMOVED) {
        const sub = measurementService.subscribe(
          events.MEASUREMENT_REMOVED,
          handleMeasurementRemoved
        );
        if (sub) subs.push(sub);
        console.log('[AnnotationSync] Subscribed to MEASUREMENT_REMOVED');
      }

      subscriptionsRef.current = subs;
    }

    console.log('[AnnotationSync] Measurement sync setup complete');

    return () => {
      console.log('[AnnotationSync] Cleaning up measurement subscriptions');
      subscriptionsRef.current.forEach(sub => {
        try {
          sub.unsubscribe();
        } catch (e) {
          // Ignore cleanup errors
        }
      });
      subscriptionsRef.current = [];
      completedAnnotationsRef.current.clear();
      lastBroadcastTimeRef.current.clear();
    };
  }, [isEnabled, collaborationService, sessionId, servicesManager, getMeasurementService, serializeMeasurement]);

  // Handle remote annotation events from collaboration service
  useEffect(() => {
    if (!isEnabled || !collaborationService) return;

    // Handler for remote annotation added (completed)
    const handleRemoteAnnotationAdded = (data: any) => {
      console.log('[AnnotationSync] Received remote completed annotation:', data?.uid);
      applyRemoteMeasurement(data);
    };

    // Handler for remote annotation modified (during drawing)
    const handleRemoteAnnotationModified = (data: { annotationId: string; changes: any }) => {
      // Only apply if we don't already have this annotation completed
      if (!completedAnnotationsRef.current.has(data.annotationId)) {
        applyRemoteMeasurement({ ...data.changes, uid: data.annotationId });
      }
    };

    // Handler for remote annotation deleted
    const handleRemoteAnnotationDeleted = (data: { annotationId: string }) => {
      console.log('[AnnotationSync] Received remote deletion:', data?.annotationId);
      if (data?.annotationId) {
        removeMeasurement(data.annotationId);
      }
    };

    // Subscribe to collaboration service events
    collaborationService.on('annotation:added', handleRemoteAnnotationAdded);
    collaborationService.on('annotation:modified', handleRemoteAnnotationModified);
    collaborationService.on('annotation:deleted', handleRemoteAnnotationDeleted);

    console.log('[AnnotationSync] Subscribed to remote annotation events');

    return () => {
      collaborationService.off('annotation:added', handleRemoteAnnotationAdded);
      collaborationService.off('annotation:modified', handleRemoteAnnotationModified);
      collaborationService.off('annotation:deleted', handleRemoteAnnotationDeleted);
      console.log('[AnnotationSync] Unsubscribed from remote annotation events');
    };
  }, [isEnabled, collaborationService, applyRemoteMeasurement, removeMeasurement]);

  return {
    applyRemoteMeasurement,
    removeMeasurement,
    serializeMeasurement,
  };
}

export default useAnnotationSync;
