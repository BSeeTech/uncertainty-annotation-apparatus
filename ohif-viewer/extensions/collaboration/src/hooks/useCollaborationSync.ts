/**
 * useCollaborationSync.ts
 * 
 * React hook that manages real-time synchronization between collaboration participants
 * This is the KEY component that connects CollaborationService events to actual viewport/annotation changes
 * 
 * Location: extensions/collaboration/src/hooks/useCollaborationSync.ts
 */

import { useEffect, useRef, useCallback } from 'react';
import {
  captureViewportState,
  applyViewportState,
  setupViewportChangeListeners,
  getActiveViewportInfo,
  SerializedViewportState,
} from '../utils/viewportSync';
import {
  serializeAnnotation,
  applyRemoteAnnotation,
  removeRemoteAnnotation,
  modifyRemoteAnnotation,
  setupAnnotationChangeListeners,
  loadSessionAnnotations,
  SerializedAnnotation,
} from '../utils/annotationSync';

interface UseCollaborationSyncOptions {
  servicesManager: any;
  collaborationService: any;
  enabled?: boolean;
}

interface UseCollaborationSyncReturn {
  isActive: boolean;
  role: 'presenter' | 'follower' | null;
  sessionId: string | null;
}

/**
 * Hook that manages bidirectional synchronization for collaboration
 * - Presenters: capture and broadcast viewport/annotation changes
 * - Followers: receive and apply changes from presenter
 */
export function useCollaborationSync({
  servicesManager,
  collaborationService,
  enabled = true,
}: UseCollaborationSyncOptions): UseCollaborationSyncReturn {
  
  const cleanupRef = useRef<(() => void)[]>([]);
  const isSetup = useRef(false);
  const lastAppliedState = useRef<number>(0);

  // Cleanup function
  const cleanup = useCallback(() => {
    cleanupRef.current.forEach(fn => {
      try {
        fn();
      } catch (e) {
        console.warn('[useCollaborationSync] Cleanup error:', e);
      }
    });
    cleanupRef.current = [];
    isSetup.current = false;
  }, []);

  // Setup synchronization
  useEffect(() => {
    if (!enabled || !collaborationService || !servicesManager) {
      return;
    }

    const setupSync = () => {
      // Avoid duplicate setup
      if (isSetup.current) {
        return;
      }

      const role = collaborationService.getRole?.();
      const sessionId = collaborationService.getSessionId?.();
      
      if (!sessionId) {
        console.log('[useCollaborationSync] No active session, skipping setup');
        return;
      }

      console.log(`[useCollaborationSync] Setting up sync for role: ${role}, session: ${sessionId}`);
      isSetup.current = true;

      // ==========================================
      // PRESENTER SETUP: Broadcast changes
      // ==========================================
      if (role === 'presenter') {
        setupPresenterSync();
      }

      // ==========================================
      // FOLLOWER SETUP: Apply remote changes
      // ==========================================
      setupFollowerSync();
    };

    // Setup presenter broadcasting
    const setupPresenterSync = () => {
      const viewportInfo = getActiveViewportInfo(servicesManager);
      
      if (viewportInfo) {
        // Setup viewport change listener
        const cleanupViewport = setupViewportChangeListeners(
          viewportInfo.viewportId,
          viewportInfo.renderingEngineId,
          (state: SerializedViewportState) => {
            // Only broadcast if we're still presenter
            if (collaborationService.getRole?.() === 'presenter') {
              collaborationService.broadcastViewportUpdate(state);
            }
          },
          { throttleMs: 100 }
        );
        cleanupRef.current.push(cleanupViewport);
        console.log('[useCollaborationSync] Presenter viewport listener setup');
      }

      // Setup annotation change listeners
      const cleanupAnnotations = setupAnnotationChangeListeners(
        // On annotation added
        (annotation: SerializedAnnotation) => {
          if (collaborationService.getRole?.() === 'presenter' || collaborationService.isActive?.()) {
            collaborationService.broadcastAnnotationAdded(annotation);
          }
        },
        // On annotation modified
        (annotationUID: string, changes: Partial<SerializedAnnotation>) => {
          if (collaborationService.getRole?.() === 'presenter' || collaborationService.isActive?.()) {
            collaborationService.broadcastAnnotationModified(annotationUID, changes);
          }
        },
        // On annotation deleted
        (annotationUID: string) => {
          if (collaborationService.getRole?.() === 'presenter' || collaborationService.isActive?.()) {
            collaborationService.broadcastAnnotationDeleted(annotationUID);
          }
        }
      );
      cleanupRef.current.push(cleanupAnnotations);
      console.log('[useCollaborationSync] Presenter annotation listeners setup');
    };

    // Setup follower receiving
    const setupFollowerSync = () => {
      // Handle incoming viewport updates
      const handleViewportUpdate = (state: SerializedViewportState) => {
        // Only apply if we're a follower
        if (collaborationService.getRole?.() !== 'follower') {
          return;
        }

        // Debounce: skip if this state is older than what we last applied
        if (state.timestamp && state.timestamp <= lastAppliedState.current) {
          return;
        }
        lastAppliedState.current = state.timestamp || Date.now();

        console.log('[useCollaborationSync] Applying viewport state from presenter');
        
        // Get current active viewport
        const viewportInfo = getActiveViewportInfo(servicesManager);
        if (viewportInfo) {
          const success = applyViewportState(
            state,
            viewportInfo.viewportId,
            viewportInfo.renderingEngineId
          );
          if (!success) {
            console.warn('[useCollaborationSync] Failed to apply viewport state');
          }
        }
      };

      // Handle incoming annotation added
      const handleAnnotationAdded = (annotation: SerializedAnnotation) => {
        console.log('[useCollaborationSync] Applying remote annotation:', annotation.annotationUID);
        applyRemoteAnnotation(annotation, servicesManager);
      };

      // Handle incoming annotation modified
      const handleAnnotationModified = (data: { annotationUID: string; changes: Partial<SerializedAnnotation> }) => {
        console.log('[useCollaborationSync] Modifying remote annotation:', data.annotationUID);
        modifyRemoteAnnotation(data.annotationUID, data.changes, servicesManager);
      };

      // Handle incoming annotation deleted
      const handleAnnotationDeleted = (data: { annotationUID: string }) => {
        console.log('[useCollaborationSync] Removing remote annotation:', data.annotationUID);
        removeRemoteAnnotation(data.annotationUID, servicesManager);
      };

      // Handle session state (initial load)
      const handleSessionState = (state: any) => {
        console.log('[useCollaborationSync] Loading session state');
        if (state.annotations && Array.isArray(state.annotations)) {
          loadSessionAnnotations(state.annotations, servicesManager);
        }
      };

      // Handle role changes
      const handleRoleChanged = (data: { role: 'presenter' | 'follower' }) => {
        console.log('[useCollaborationSync] Role changed to:', data.role);
        // Re-setup based on new role
        cleanup();
        setTimeout(setupSync, 100);
      };

      // Subscribe to collaboration service events
      collaborationService.on('viewport:update', handleViewportUpdate);
      collaborationService.on('annotation:added', handleAnnotationAdded);
      collaborationService.on('annotation:modified', handleAnnotationModified);
      collaborationService.on('annotation:deleted', handleAnnotationDeleted);
      collaborationService.on('session:state', handleSessionState);
      collaborationService.on('role:changed', handleRoleChanged);

      // Add cleanup
      cleanupRef.current.push(() => {
        collaborationService.off('viewport:update', handleViewportUpdate);
        collaborationService.off('annotation:added', handleAnnotationAdded);
        collaborationService.off('annotation:modified', handleAnnotationModified);
        collaborationService.off('annotation:deleted', handleAnnotationDeleted);
        collaborationService.off('session:state', handleSessionState);
        collaborationService.off('role:changed', handleRoleChanged);
      });

      console.log('[useCollaborationSync] Follower sync listeners setup');
    };

    // Session event handlers
    const handleSessionJoined = () => {
      console.log('[useCollaborationSync] Session joined, setting up sync');
      // Small delay to ensure everything is initialized
      setTimeout(setupSync, 200);
    };

    const handleSessionLeft = () => {
      console.log('[useCollaborationSync] Session left, cleaning up');
      cleanup();
    };

    const handleConnectionClosed = () => {
      console.log('[useCollaborationSync] Connection closed, cleaning up');
      cleanup();
    };

    // Subscribe to session lifecycle events
    collaborationService.on('session:joined', handleSessionJoined);
    collaborationService.on('session:left', handleSessionLeft);
    collaborationService.on('connection:closed', handleConnectionClosed);

    // If already in a session, setup immediately
    if (collaborationService.getSessionId?.()) {
      setupSync();
    }

    // Cleanup on unmount
    return () => {
      collaborationService.off('session:joined', handleSessionJoined);
      collaborationService.off('session:left', handleSessionLeft);
      collaborationService.off('connection:closed', handleConnectionClosed);
      cleanup();
    };
  }, [enabled, collaborationService, servicesManager, cleanup]);

  // Return current state
  return {
    isActive: collaborationService?.isActive?.() || false,
    role: collaborationService?.getRole?.() || null,
    sessionId: collaborationService?.getSessionId?.() || null,
  };
}

export default useCollaborationSync;
