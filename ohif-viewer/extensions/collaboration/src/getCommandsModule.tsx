/**
 * getCommandsModule.tsx
 * 
 * Commands module for the Collaboration extension.
 * Provides commands for collaboration session management.
 * 
 * Location: extensions/collaboration/src/getCommandsModule.tsx
 */

import { ServicesManager } from '@ohif/core';

export default function getCommandsModule({
  servicesManager,
}: {
  servicesManager: ServicesManager;
}) {
  const actions = {
    /**
     * Start a new collaboration session as presenter
     */
    startCollaborationSession: ({ sessionId }: { sessionId?: string }) => {
      const { collaborationService } = servicesManager.services;
      if (collaborationService) {
        return collaborationService.createSession(sessionId);
      }
      console.warn('[Collaboration] CollaborationService not available');
      return null;
    },

    /**
     * Join an existing collaboration session as follower
     */
    joinCollaborationSession: ({ sessionId }: { sessionId: string }) => {
      const { collaborationService } = servicesManager.services;
      if (collaborationService) {
        return collaborationService.joinSession(sessionId);
      }
      console.warn('[Collaboration] CollaborationService not available');
      return null;
    },

    /**
     * Leave the current collaboration session
     */
    leaveCollaborationSession: () => {
      const { collaborationService } = servicesManager.services;
      if (collaborationService) {
        return collaborationService.leaveSession();
      }
      console.warn('[Collaboration] CollaborationService not available');
      return null;
    },

    /**
     * Toggle follow mode for followers
     */
    toggleFollowMode: ({ enabled }: { enabled?: boolean }) => {
      const { collaborationService } = servicesManager.services;
      if (collaborationService) {
        const currentState = collaborationService.isFollowing?.() ?? true;
        const newState = enabled !== undefined ? enabled : !currentState;
        collaborationService.setFollowing?.(newState);
        return newState;
      }
      console.warn('[Collaboration] CollaborationService not available');
      return null;
    },

    /**
     * Get current collaboration session info
     */
    getCollaborationSessionInfo: () => {
      const { collaborationService } = servicesManager.services;
      if (collaborationService) {
        return {
          sessionId: collaborationService.getSessionId?.(),
          role: collaborationService.getRole?.(),
          isConnected: collaborationService.isConnected?.(),
          participantCount: collaborationService.getParticipantCount?.(),
        };
      }
      return null;
    },
  };

  const definitions = {
    startCollaborationSession: {
      commandFn: actions.startCollaborationSession,
      storeContexts: [],
      options: {},
    },
    joinCollaborationSession: {
      commandFn: actions.joinCollaborationSession,
      storeContexts: [],
      options: {},
    },
    leaveCollaborationSession: {
      commandFn: actions.leaveCollaborationSession,
      storeContexts: [],
      options: {},
    },
    toggleFollowMode: {
      commandFn: actions.toggleFollowMode,
      storeContexts: [],
      options: {},
    },
    getCollaborationSessionInfo: {
      commandFn: actions.getCollaborationSessionInfo,
      storeContexts: [],
      options: {},
    },
  };

  return {
    actions,
    definitions,
    defaultContext: 'COLLABORATION',
  };
}
