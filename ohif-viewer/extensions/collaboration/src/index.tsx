/**
 * Collaboration Extension for OHIF Viewer
 * 
 * This extension provides real-time collaboration features including:
 * - Session management (create, join, leave)
 * - Viewport synchronization (scroll, zoom, pan, window/level, rotation, flip, invert)
 * - Annotation sharing (create, modify, delete)
 * 
 * Location: extensions/collaboration/src/index.tsx
 */

import React from 'react';
import CollaborationService from './services/CollaborationService';
import CollaborationPanel from './components/CollaborationPanel';

// Extension ID - must match what's used in pluginConfig.json and mode references
const id = 'collaboration';

const extension = {
  id,
  version: '0.1.0',

  /**
   * Pre-registration hook
   * Called before the extension is fully registered
   */
  preRegistration: ({ servicesManager, configuration = {} }) => {
    if (CollaborationService?.REGISTRATION) {
      servicesManager.registerService(CollaborationService.REGISTRATION);
      console.log(`✅ CollaborationService registered`);
    } else {
      console.warn(`⚠️ CollaborationService.REGISTRATION is undefined`);
    }
  },

  /**
   * Get Panel Module
   * Returns the collaboration panel component
   */
  getPanelModule: ({ servicesManager, commandsManager, extensionManager }) => {
    return [
      {
        name: 'collaboration',
        iconName: 'tab-linear',
        iconLabel: 'Collaboration',
        label: 'Collaboration',
        component: (props) => (
          <CollaborationPanel
            servicesManager={servicesManager}
            commandsManager={commandsManager}
            extensionManager={extensionManager}
            {...props}
          />
        ),
      },
    ];
  },

  /**
   * Get Commands Module
   * Registers commands that can be executed programmatically
   */
  getCommandsModule: ({ servicesManager, commandsManager }) => {
    return {
      definitions: {
        // Connection commands
        connectToCollaboration: {
          commandFn: async () => {
            const { collaborationService } = servicesManager.services;
            if (collaborationService) {
              await collaborationService.connect();
            } else {
              console.error('CollaborationService not available');
            }
          },
          storeContexts: [],
          options: {},
        },
        disconnectFromCollaboration: {
          commandFn: () => {
            const { collaborationService } = servicesManager.services;
            collaborationService?.disconnect();
          },
          storeContexts: [],
          options: {},
        },

        // Session commands
        createCollaborationSession: {
          commandFn: async ({ studyInstanceUID }) => {
            const { collaborationService } = servicesManager.services;
            return await collaborationService?.createSession(studyInstanceUID);
          },
          storeContexts: [],
          options: {},
        },
        joinCollaborationSession: {
          commandFn: async ({ sessionId }) => {
            const { collaborationService } = servicesManager.services;
            return await collaborationService?.joinSession(sessionId);
          },
          storeContexts: [],
          options: {},
        },
        leaveCollaborationSession: {
          commandFn: () => {
            const { collaborationService } = servicesManager.services;
            collaborationService?.leaveSession();
          },
          storeContexts: [],
          options: {},
        },

        // Role commands
        switchCollaborationRole: {
          commandFn: ({ role }) => {
            const { collaborationService } = servicesManager.services;
            collaborationService?.switchRole(role);
          },
          storeContexts: [],
          options: {},
        },
      },
      defaultContext: 'COLLABORATION',
    };
  },
};

export default extension;
