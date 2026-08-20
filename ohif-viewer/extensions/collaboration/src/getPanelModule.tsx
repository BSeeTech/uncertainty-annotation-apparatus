/**
 * getPanelModule.tsx
 * 
 * Panel module for the Collaboration extension.
 * Registers the CollaborationPanel component.
 * 
 * Location: extensions/collaboration/src/getPanelModule.tsx
 */

import React from 'react';
import { ServicesManager, CommandsManager } from '@ohif/core';
import CollaborationPanel from './components/CollaborationPanel';

export default function getPanelModule({
  servicesManager,
  commandsManager,
  extensionManager,
}: {
  servicesManager: ServicesManager;
  commandsManager: CommandsManager;
  extensionManager: any;
}) {
  return [
    {
      name: 'collaborationPanel',
      iconName: 'tab-patient-info', // Or use a custom collaboration icon
      iconLabel: 'Collaboration',
      label: 'Collaboration',
      component: (props: any) => {
        return (
          <CollaborationPanel
            servicesManager={servicesManager}
            commandsManager={commandsManager}
            extensionManager={extensionManager}
            {...props}
          />
        );
      },
    },
  ];
}
