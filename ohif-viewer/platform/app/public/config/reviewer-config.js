// reviewer-config.js — OHIF configuration for the reviewer Docker profile.
//
// This config is mounted at /usr/share/nginx/html/app-config/reviewer-config.js
// inside the reviewer-ohif container.  It overrides the default OHIF config
// to point all data sources at the pre-computed uncertainty service and
// disable live PACS connections.
//
// Environment variables REVIEWER_ID and CONDITION are set in the Docker
// Compose profile. The uncertainty-review mode reads the reviewer and
// condition from the session URL (?reviewer=...&condition=...); the
// container environment is not consumed at runtime.
//
window.reviewerConfig = {
  // ---- Router ----
  routerBasename: '/',

  // ---- Data Sources ----
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSources.dicomweb',
      sourceName: 'dicomweb',
      configuration: {
        name: 'DICOMWeb',
        wadoUriRoot: '',
        qidoRoot: '',
        wadoRoot: '',
        qidoSupportsIncludeField: false,
        supportsReject: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        // No live DICOM PACS — all data comes via the uncertainty service
        // which serves pre-computed NIfTI artifacts from a volume mount.
        // The case browser is disabled; reviewers enter via direct URL
        // (uncertainty-review mode with ?reviewer=...&condition=...).
        suppressStudyList: true,
      },
    },
  ],

  // ---- Default Extension ----
  defaultDataSourceName: 'dicomweb',

  // ---- Extension Registration ----
  extensionManager: {
    modules: [
      '@ohif/extension-default',
      '@ohif/extension-cornerstone',
      '@ohif/extension-measurement-tracking',
      '@thesis/extension-uncertainty',
    ],
  },

  // ---- Mode Registration ----
  modes: [],

  // ---- Hotkeys ----
  hotkeys: [
    { commandName: 'nextCase', label: 'Next Case', keys: ['Right'] },
    { commandName: 'prevCase', label: 'Previous Case', keys: ['Left'] },
    { commandName: 'accept', label: 'Accept', keys: ['a'] },
    { commandName: 'reject', label: 'Reject', keys: ['r'] },
    { commandName: 'edit', label: 'Toggle Edit', keys: ['e'] },
    { commandName: 'toggleHeatmap', label: 'Toggle Heatmap', keys: ['h'] },
  ],

  // ---- UI ----
  ui: {
    studyList: {
      enabled: false,
    },
  },

  // ---- White Labeling ----
  whiteLabeling: {
    createLogoComponentFn: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgdmlld0JveD0iMCAwIDMyIDMyIj48dGV4dCB4PSI0IiB5PSIyNCIgZm9udC1zaXplPSIyMCI+TUlQPC90ZXh0Pjwvc3ZnPg==',
    branding: {
      logo: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDgwIDQwIj48dGV4dCB4PSI0IiB5PSIzMCIgZm9udC1zaXplPSIxNCI+UmV2aWV3ZXI8L3RleHQ+PC9zdmc+',
      backgroundColor: '#1a1a2e',
    },
  },

  // ---- Servers ----
  servers: {
    // The uncertainty service endpoints (maps to reviewer-uncertainty container)
    uncertainty: {
      worklist: '/worklist',
      infer: '/infer',
      events: '/events',
      annotations: '/annotations',
      results: '/results',
    },
  },
};
