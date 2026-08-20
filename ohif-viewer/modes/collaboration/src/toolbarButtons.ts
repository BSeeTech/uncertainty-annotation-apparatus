/**
 * Toolbar button definitions for Collaboration Mode
 * Based on longitudinal mode toolbar configuration
 * 
 * Location: modes/collaboration/src/toolbarButtons.ts
 * 
 * NOTE: Icon names must match what OHIF has registered.
 * If icons show as "Missing Icon", check the icon name in the OHIF source.
 */

const _createSetToolActiveCommands = toolName => {
  return [
    {
      commandName: 'setToolActive',
      commandOptions: {
        toolName,
      },
      context: 'CORNERSTONE',
    },
  ];
};

const toolbarButtons = [
  // Measurement Tools Group - matches Basic Viewer exactly
  {
    id: 'MeasurementTools',
    uiType: 'ohif.splitButton',
    props: {
      groupId: 'MeasurementTools',
      evaluate: 'evaluate.group.promoteToPrimaryIfCornerstoneToolNotActiveInTheList',
      primary: {
        id: 'Length',
        icon: 'tool-length',
        label: 'Length',
        tooltip: 'Length Tool',
        commands: _createSetToolActiveCommands('Length'),
        evaluate: 'evaluate.cornerstoneTool',
      },
      secondary: {
        icon: 'chevron-down',
        tooltip: 'More Measure Tools',
      },
      items: [
        {
          id: 'Length',
          icon: 'tool-length',
          label: 'Length',
          tooltip: 'Length Tool',
          commands: _createSetToolActiveCommands('Length'),
          evaluate: 'evaluate.cornerstoneTool',
        },
        {
          id: 'Bidirectional',
          icon: 'tool-bidirectional',
          label: 'Bidirectional',
          tooltip: 'Bidirectional Tool',
          commands: _createSetToolActiveCommands('Bidirectional'),
          evaluate: 'evaluate.cornerstoneTool',
        },
        {
          id: 'ArrowAnnotate',
          icon: 'tool-annotate',
          label: 'Annotation',
          tooltip: 'Arrow Annotate',
          commands: _createSetToolActiveCommands('ArrowAnnotate'),
          evaluate: 'evaluate.cornerstoneTool',
        },
        {
          id: 'EllipticalROI',
          icon: 'tool-ellipse',
          label: 'Ellipse',
          tooltip: 'Ellipse ROI',
          commands: _createSetToolActiveCommands('EllipticalROI'),
          evaluate: 'evaluate.cornerstoneTool',
        },
        {
          id: 'RectangleROI',
          icon: 'tool-rectangle',
          label: 'Rectangle',
          tooltip: 'Rectangle ROI',
          commands: _createSetToolActiveCommands('RectangleROI'),
          evaluate: 'evaluate.cornerstoneTool',
        },
        {
          id: 'CircleROI',
          icon: 'tool-circle',
          label: 'Circle',
          tooltip: 'Circle ROI',
          commands: _createSetToolActiveCommands('CircleROI'),
          evaluate: 'evaluate.cornerstoneTool',
        },
        // NOTE: Freehand, Spline, Livewire removed - icons not available in this OHIF version
        // If you need these tools, find the correct icon names from:
        // ohif-viewer/platform/ui/src/components/Icons/
      ],
    },
  },
  // Zoom
  {
    id: 'Zoom',
    uiType: 'ohif.radioGroup',
    props: {
      icon: 'tool-zoom',
      label: 'Zoom',
      commands: _createSetToolActiveCommands('Zoom'),
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  // Window Level
  {
    id: 'WindowLevel',
    uiType: 'ohif.radioGroup',
    props: {
      icon: 'tool-window-level',
      label: 'Window Level',
      commands: _createSetToolActiveCommands('WindowLevel'),
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  // Pan
  {
    id: 'Pan',
    uiType: 'ohif.radioGroup',
    props: {
      icon: 'tool-move',
      label: 'Pan',
      commands: _createSetToolActiveCommands('Pan'),
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
  // Capture
  {
    id: 'Capture',
    uiType: 'ohif.radioGroup',
    props: {
      icon: 'tool-capture',
      label: 'Capture',
      commands: [
        {
          commandName: 'showDownloadViewportModal',
          commandOptions: {},
          context: 'CORNERSTONE',
        },
      ],
    },
  },
  // Layout
  {
    id: 'Layout',
    uiType: 'ohif.layoutSelector',
    props: {
      rows: 3,
      columns: 3,
    },
  },
  // Crosshairs
  {
    id: 'Crosshairs',
    uiType: 'ohif.radioGroup',
    props: {
      icon: 'tool-crosshair',
      label: 'Crosshairs',
      commands: _createSetToolActiveCommands('Crosshairs'),
      evaluate: 'evaluate.cornerstoneTool',
    },
  },
];

// More tools for the dropdown
const moreTools = [
  {
    id: 'MoreTools',
    uiType: 'ohif.splitButton',
    props: {
      groupId: 'MoreTools',
      evaluate: 'evaluate.group.promoteToPrimaryIfCornerstoneToolNotActiveInTheList',
      primary: {
        id: 'Reset',
        icon: 'tool-reset',
        tooltip: 'Reset View',
        label: 'Reset',
        commands: [
          {
            commandName: 'resetViewport',
            commandOptions: {},
            context: 'CORNERSTONE',
          },
        ],
        evaluate: 'evaluate.action',
      },
      secondary: {
        icon: 'chevron-down',
        tooltip: 'More Tools',
      },
      items: [
        {
          id: 'Reset',
          icon: 'tool-reset',
          label: 'Reset View',
          tooltip: 'Reset View',
          commands: [
            {
              commandName: 'resetViewport',
              commandOptions: {},
              context: 'CORNERSTONE',
            },
          ],
          evaluate: 'evaluate.action',
        },
        {
          id: 'RotateRight',
          icon: 'tool-rotate-right',
          label: 'Rotate Right',
          tooltip: 'Rotate +90',
          commands: [
            {
              commandName: 'rotateViewportCW',
              commandOptions: {},
              context: 'CORNERSTONE',
            },
          ],
          evaluate: 'evaluate.action',
        },
        {
          id: 'FlipHorizontal',
          icon: 'tool-flip-horizontal',
          label: 'Flip Horizontally',
          tooltip: 'Flip Horizontally',
          commands: [
            {
              commandName: 'flipViewportHorizontal',
              commandOptions: {},
              context: 'CORNERSTONE',
            },
          ],
          evaluate: 'evaluate.action',
        },
        {
          id: 'FlipVertical',
          icon: 'tool-flip-vertical',
          label: 'Flip Vertically',
          tooltip: 'Flip Vertically',
          commands: [
            {
              commandName: 'flipViewportVertical',
              commandOptions: {},
              context: 'CORNERSTONE',
            },
          ],
          evaluate: 'evaluate.action',
        },
        {
          id: 'Invert',
          icon: 'tool-invert',
          label: 'Invert',
          tooltip: 'Invert Colors',
          commands: [
            {
              commandName: 'invertViewport',
              commandOptions: {},
              context: 'CORNERSTONE',
            },
          ],
          evaluate: 'evaluate.action',
        },
        {
          id: 'StackScroll',
          icon: 'tool-stack-scroll',
          label: 'Stack Scroll',
          tooltip: 'Stack Scroll',
          commands: _createSetToolActiveCommands('StackScroll'),
          evaluate: 'evaluate.cornerstoneTool',
        },
        {
          id: 'Magnify',
          icon: 'tool-magnify',
          label: 'Magnify',
          tooltip: 'Magnify',
          commands: _createSetToolActiveCommands('Magnify'),
          evaluate: 'evaluate.cornerstoneTool',
        },
        {
          id: 'Cine',
          icon: 'tool-cine',
          label: 'Cine',
          tooltip: 'Cine',
          commands: [
            {
              commandName: 'toggleCine',
              commandOptions: {},
              context: 'CORNERSTONE',
            },
          ],
          evaluate: 'evaluate.cine',
        },
      ],
    },
  },
];

export { toolbarButtons, moreTools };
export default toolbarButtons;
