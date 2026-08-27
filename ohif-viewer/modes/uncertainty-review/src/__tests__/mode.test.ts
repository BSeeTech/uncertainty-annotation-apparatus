import modeManifest, {
  getCommandsModule,
  ensureReferenceVolumeCached,
  id,
  imageIdsFromDisplaySet,
  installReviewerTelemetry,
  modeFactory,
  resolveSegmentationIdForReference,
  uniqueImageIdsBySopInstance,
} from '../index';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';

describe('reference volume image selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    (cornerstone as any).cache.getVolume.mockReturnValue(null);
  });

  it('uses one canonical image-id source instead of duplicating slices across aliases', () => {
    expect(
      imageIdsFromDisplaySet({
        imageIds: ['wadors:one', 'wadors:two'],
        images: [{ imageId: 'dicomweb:one' }, { imageId: 'dicomweb:two' }],
        instances: [{ wadorsuri: 'http://one' }, { wadorsuri: 'http://two' }],
      })
    ).toEqual(['wadors:one', 'wadors:two']);
  });

  it('falls back to image metadata when direct imageIds are unavailable', () => {
    expect(
      imageIdsFromDisplaySet({
        images: [{ imageId: 'dicomweb:one' }, { imageId: 'dicomweb:two' }],
      })
    ).toEqual(['dicomweb:one', 'dicomweb:two']);
  });

  it('deduplicates alternate image URLs that identify the same SOP instance', () => {
    expect(
      uniqueImageIdsBySopInstance([
        'wadors:http://orthanc/dicom-web/studies/a/series/b/instances/1.2.3/frames/1',
        'dicomweb:http://orthanc/dicom-web/studies/a/series/b/instances/1.2.3/frames/1',
        'wadors:http://orthanc/dicom-web/studies/a/series/b/instances/1.2.4/frames/1',
      ])
    ).toEqual([
      'wadors:http://orthanc/dicom-web/studies/a/series/b/instances/1.2.3/frames/1',
      'wadors:http://orthanc/dicom-web/studies/a/series/b/instances/1.2.4/frames/1',
    ]);
  });

  it('rebuilds a cached reference volume whose slice count is stale', async () => {
    const core = cornerstone as any;
    const load = jest.fn().mockResolvedValue(undefined);
    core.cache.getVolume.mockReturnValue({ dimensions: [512, 512, 114] });
    core.volumeLoader.createAndCacheVolume.mockResolvedValue({ load });

    await ensureReferenceVolumeCached('cornerstoneStreamingImageVolume:display-set', {
      imageIds: ['wadors:one', 'wadors:two'],
    });

    expect(core.cache.removeVolumeLoadObject).toHaveBeenCalledWith(
      'cornerstoneStreamingImageVolume:display-set'
    );
    expect(core.volumeLoader.createAndCacheVolume).toHaveBeenCalledWith(
      'cornerstoneStreamingImageVolume:display-set',
      { imageIds: ['wadors:one', 'wadors:two'] }
    );
    expect(load).toHaveBeenCalled();
  });

  it('reuses a cached reference volume with the expected slice count', async () => {
    const core = cornerstone as any;
    core.cache.getVolume.mockReturnValue({ dimensions: [512, 512, 2] });

    await ensureReferenceVolumeCached('cornerstoneStreamingImageVolume:display-set', {
      imageIds: ['wadors:one', 'wadors:two'],
    });

    expect(core.cache.removeVolumeLoadObject).not.toHaveBeenCalled();
    expect(core.volumeLoader.createAndCacheVolume).not.toHaveBeenCalled();
  });
});

describe('review telemetry bridge', () => {
  it('subscribes core and segmentation events on the Cornerstone core target', () => {
    const service = {
      logViewerEvent: jest.fn(),
      recordSegmentationChange: jest.fn(),
    } as any;
    installReviewerTelemetry(service);

    cornerstone.eventTarget.dispatchEvent(
      new CustomEvent(cornerstone.Enums.Events.STACK_NEW_IMAGE, {
        detail: { viewportId: 'vp1', imageIndex: 4 },
      })
    );
    cornerstone.eventTarget.dispatchEvent(
      new CustomEvent(cornerstone.Enums.Events.CAMERA_MODIFIED, { detail: { viewportId: 'vp1' } })
    );
    cornerstone.eventTarget.dispatchEvent(
      new CustomEvent(cornerstoneTools.Enums.Events.SEGMENTATION_DATA_MODIFIED, {
        detail: { segmentationId: 'seg1' },
      })
    );
    cornerstone.eventTarget.dispatchEvent(
      new CustomEvent(cornerstoneTools.Enums.Events.SEGMENTATION_REPRESENTATION_MODIFIED, {
        detail: { segmentationId: 'seg1', type: 'Labelmap' },
      })
    );

    expect(service.logViewerEvent).toHaveBeenCalledWith('slice_change', {
      viewportId: 'vp1',
      imageIndex: 4,
    });
    expect(service.logViewerEvent).toHaveBeenCalledWith('viewport_change', {
      viewportId: 'vp1',
    });
    expect(service.recordSegmentationChange).toHaveBeenCalledWith({
      segmentationId: 'seg1',
      modifiedSlicesToUse: null,
    });
    expect(service.logViewerEvent).toHaveBeenCalledWith('structure_focus', {
      segmentationId: 'seg1',
      type: 'Labelmap',
    });
  });
});

describe('mode factory', () => {
  it('exports an OHIF mode manifest as the default export', () => {
    expect(modeManifest).toEqual(
      expect.objectContaining({
        id,
        modeFactory,
        extensionDependencies: expect.objectContaining({
          '@ohif/extension-default': expect.any(String),
          '@ohif/extension-cornerstone': expect.any(String),
          '@ohif/extension-monai-label': expect.any(String),
          '@thesis/extension-uncertainty': expect.any(String),
        }),
      })
    );
  });

  it('exposes the canonical id and routeName', () => {
    const mode = modeFactory();
    expect(mode.id).toBe(id);
    expect(mode.id).toBe('@thesis/mode-uncertainty-review');
    expect(mode.routeName).toBe('uncertainty-review');
  });

  it('declares the correct extension dependency list', () => {
    const mode = modeFactory();
    expect(mode.extensions).toEqual(
      expect.objectContaining({
        '@ohif/extension-default': expect.any(String),
        '@ohif/extension-cornerstone': expect.any(String),
        '@ohif/extension-monai-label': expect.any(String),
        '@thesis/extension-uncertainty': expect.any(String),
      })
    );
  });

  it('mounts the worklist panel on the left and review controls on the right', () => {
    const mode = modeFactory();
    const route = mode.routes[0];
    const layout = route.layoutTemplate();
    expect(layout.props.leftPanels).toContain('@thesis/extension-uncertainty.panelModule.worklist');
    expect(layout.props.rightPanels).toContain(
      '@thesis/extension-uncertainty.panelModule.uncertainty'
    );
    expect(layout.props.rightPanels).toContain(
      '@thesis/extension-uncertainty.panelModule.submission'
    );
    expect(layout.props.rightPanels).toContain(
      '@ohif/extension-monai-label.panelModule.monailabel'
    );
  });

  it('declares the four expected hotkeys', () => {
    const mode = modeFactory();
    const commands = mode.hotkeys.map(h => h.commandName);
    expect(commands).toEqual(
      expect.arrayContaining([
        'toggleUncertaintyHeatmap',
        'acceptUncertaintyAnnotation',
        'rejectUncertaintyAnnotation',
        'refreshUncertaintyWorklist',
      ])
    );
    // The toggle hotkey must be 'u' so the LR section on heatmap UX
    // matches the reviewer's actual experience during the user study.
    const toggle = mode.hotkeys.find(h => h.commandName === 'toggleUncertaintyHeatmap');
    expect(toggle?.keys).toEqual(['u']);
  });
});

describe('isValidMode', () => {
  const mode = modeFactory();
  it('accepts a CT-only study', () => {
    expect(mode.isValidMode({ modalities: 'CT' }).valid).toBe(true);
  });
  it('accepts a CT study with a derived SEG object', () => {
    expect(mode.isValidMode({ modalities: 'CT\\SEG' }).valid).toBe(true);
  });
  it('rejects MR and PT/MR studies', () => {
    expect(mode.isValidMode({ modalities: 'MR' }).valid).toBe(false);
    expect(mode.isValidMode({ modalities: 'PT\\MR' }).valid).toBe(false);
  });
  it('rejects unsupported modalities', () => {
    const result = mode.isValidMode({ modalities: 'US' });
    expect(result.valid).toBe(false);
    expect(result.description).toMatch(/CT series/);
  });
  it('rejects empty modalities string', () => {
    expect(mode.isValidMode({ modalities: '' }).valid).toBe(false);
  });
});

describe('onModeEnter', () => {
  // We import lazily so the per-test module mocks don't cross-contaminate.
  function makeServicesManager(uncertaintyService: any | null) {
    return {
      services: {
        uncertaintyService,
      },
    };
  }

  it('configures the uncertainty service from the URL when valid', () => {
    const setSession = jest.fn();
    const refreshWorklist = jest.fn();
    const configureRuntimeDependencies = jest.fn();
    const services = makeServicesManager({
      setSession,
      refreshWorklist,
      configureRuntimeDependencies,
      getState: () => ({ session: null, worklist: { items: [] } }),
    });
    const mode = modeFactory({
      modeConfiguration: { sessionSearch: '?reviewer=R03&condition=C2' },
    });
    mode.onModeEnter({
      servicesManager: services,
      extensionManager: {},
      commandsManager: {},
    } as any);
    expect(setSession).toHaveBeenCalledWith({ reviewerId: 'R03', condition: 'C2' });
    expect(refreshWorklist).toHaveBeenCalled();
    expect(configureRuntimeDependencies).toHaveBeenCalledWith(
      expect.objectContaining({
        exporter: expect.objectContaining({
          exportSegmentationAsNiftiBlob: expect.any(Function),
        }),
      })
    );
  });

  it('contains worklist refresh failures on mode entry', () => {
    const catchSpy = jest.fn();
    const refreshWorklist = jest.fn(() => ({ catch: catchSpy }));
    const services = makeServicesManager({
      setSession: jest.fn(),
      refreshWorklist,
      getState: () => ({ session: null, worklist: { items: [] } }),
    });
    const mode = modeFactory({
      modeConfiguration: { sessionSearch: '?reviewer=R03&condition=C2' },
    });

    mode.onModeEnter({
      servicesManager: services,
      extensionManager: {},
      commandsManager: {},
    } as any);

    expect(refreshWorklist).toHaveBeenCalled();
    expect(catchSpy).toHaveBeenCalledWith(expect.any(Function));
  });

  it('applies the default direct-launch session when the URL is missing/invalid', () => {
    const services = makeServicesManager({
      setSession: jest.fn(),
      refreshWorklist: jest.fn(),
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mode = modeFactory({
      modeConfiguration: { sessionSearch: '?wrong=stuff' },
    });
    mode.onModeEnter({
      servicesManager: services,
      extensionManager: {},
      commandsManager: {},
    } as any);
    expect(services.services.uncertaintyService.setSession).toHaveBeenCalledWith({
      reviewerId: 'R03',
      condition: 'C2',
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('runs openUncertaintyCase after the worklist refresh if a caseId is present in the URL', async () => {
    let resolveRefresh!: () => void;
    const refreshPromise = new Promise<void>(resolve => {
      resolveRefresh = resolve;
    });
    const openCase = jest.fn().mockResolvedValue({ case_id: 'case_007' });
    const services = makeServicesManager({
      setSession: jest.fn(),
      refreshWorklist: jest.fn(() => refreshPromise),
      getState: () => ({
        session: { reviewerId: 'R03', condition: 'C2' },
        worklist: {
          items: [
            {
              case_id: 'case_007',
              study_uid: 'study_007',
              series_uid: 'series_007',
              score: null,
              score_band: null,
              status: 'ready',
            },
          ],
        },
      }),
      selectCase: jest.fn(),
      openCase,
      markCaseOpenFailed: jest.fn(),
    });
    const runCommand = jest.fn();
    services.services.displaySetService = {
      getDisplaySetsForSeries: jest.fn(() => [
        {
          displaySetInstanceUID: 'display_set_007',
          StudyInstanceUID: 'study_007',
          SeriesInstanceUID: 'series_007',
        },
      ]),
    };
    services.services.viewportGridService = {
      getState: jest.fn(() => ({ activeViewportId: 'viewport_1' })),
    };
    services.services.cornerstoneViewportService = {
      getViewportIds: jest.fn(() => []),
    };
    const metadata = jest.fn().mockResolvedValue(undefined);
    const extensionManager = {
      getActiveDataSource: jest.fn(() => [
        {
          retrieve: {
            series: { metadata },
          },
        },
      ]),
    };
    const mode = modeFactory({
      modeConfiguration: {
        sessionSearch: '?reviewer=R03&condition=C2&caseId=case_007',
      },
    });
    mode.onModeEnter({
      servicesManager: services,
      extensionManager,
      commandsManager: { runCommand },
    } as any);

    expect(runCommand).not.toHaveBeenCalled();
    resolveRefresh();
    await refreshPromise;
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 250));
    await Promise.resolve();

    expect(runCommand).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(openCase).toHaveBeenCalledWith({
      caseId: 'case_007',
      referenceVolumeId: 'cornerstoneStreamingImageVolume:display_set_007',
      viewportIds: ['viewport_1'],
    });
  });

  it('waits for the Orthanc display set before resolving the reference volume id', async () => {
    let resolveRefresh!: () => void;
    const refreshPromise = new Promise<void>(resolve => {
      resolveRefresh = resolve;
    });
    const openCase = jest.fn().mockResolvedValue({ case_id: 'case_008' });
    const services = makeServicesManager({
      setSession: jest.fn(),
      refreshWorklist: jest.fn(() => refreshPromise),
      getState: () => ({
        session: { reviewerId: 'R03', condition: 'C2' },
        worklist: {
          items: [
            {
              case_id: 'case_008',
              study_uid: 'study_008',
              series_uid: 'series_008',
              score: null,
              score_band: null,
              status: 'ready',
            },
          ],
        },
      }),
      selectCase: jest.fn(),
      openCase,
      markCaseOpenFailed: jest.fn(),
    });
    services.services.displaySetService = {
      getDisplaySetsForSeries: jest
        .fn()
        .mockReturnValueOnce([])
        .mockReturnValue([
          {
            displaySetInstanceUID: 'display_set_008',
            StudyInstanceUID: 'study_008',
            SeriesInstanceUID: 'series_008',
          },
        ]),
    };
    services.services.viewportGridService = {
      getState: jest.fn(() => ({ activeViewportId: 'viewport_1' })),
    };
    services.services.cornerstoneViewportService = {
      getViewportIds: jest.fn(() => []),
    };
    const extensionManager = {
      getActiveDataSource: jest.fn(() => [
        {
          retrieve: {
            series: { metadata: jest.fn().mockResolvedValue(undefined) },
          },
        },
      ]),
    };
    const mode = modeFactory({
      modeConfiguration: {
        sessionSearch: '?reviewer=R03&condition=C2&caseId=case_008',
      },
    });

    mode.onModeEnter({
      servicesManager: services,
      extensionManager,
      commandsManager: {},
    } as any);

    resolveRefresh();
    await refreshPromise;
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 250));
    await Promise.resolve();

    expect(openCase).toHaveBeenCalledWith({
      caseId: 'case_008',
      referenceVolumeId: 'cornerstoneStreamingImageVolume:display_set_008',
      viewportIds: ['viewport_1'],
    });
  });

  it('updates the Cornerstone volume cache for the selected Orthanc worklist case', async () => {
    const core = cornerstone as any;
    const load = jest.fn().mockResolvedValue(undefined);
    core.cache.getVolume.mockReturnValue(null);
    core.volumeLoader.createAndCacheVolume.mockResolvedValue({ load });

    let resolveRefresh!: () => void;
    const refreshPromise = new Promise<void>(resolve => {
      resolveRefresh = resolve;
    });
    const openCase = jest.fn().mockResolvedValue({ case_id: 'case_009' });
    const services = makeServicesManager({
      setSession: jest.fn(),
      refreshWorklist: jest.fn(() => refreshPromise),
      getState: () => ({
        session: { reviewerId: 'R03', condition: 'C2' },
        worklist: {
          items: [
            {
              case_id: 'case_009',
              study_uid: 'study_009',
              series_uid: 'series_009',
              score: null,
              score_band: null,
              status: 'ready',
            },
          ],
        },
      }),
      selectCase: jest.fn(),
      openCase,
      markCaseOpenFailed: jest.fn(),
    });
    services.services.displaySetService = {
      getDisplaySetsForSeries: jest.fn(() => [
        {
          displaySetInstanceUID: 'display_set_009',
          StudyInstanceUID: 'study_009',
          SeriesInstanceUID: 'series_009',
          imageIds: ['wadors:image-1', 'wadors:image-2'],
        },
      ]),
    };
    services.services.viewportGridService = {
      getState: jest.fn(() => ({ activeViewportId: 'viewport_1' })),
    };
    services.services.cornerstoneViewportService = {
      getViewportIds: jest.fn(() => []),
    };
    const extensionManager = {
      getActiveDataSource: jest.fn(() => [
        {
          retrieve: {
            series: { metadata: jest.fn().mockResolvedValue(undefined) },
          },
        },
      ]),
    };
    const mode = modeFactory({
      modeConfiguration: {
        sessionSearch: '?reviewer=R03&condition=C2&caseId=case_009',
      },
    });

    mode.onModeEnter({
      servicesManager: services,
      extensionManager,
      commandsManager: {},
    } as any);

    resolveRefresh();
    await refreshPromise;
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(core.volumeLoader.createAndCacheVolume).toHaveBeenCalledWith(
      'cornerstoneStreamingImageVolume:display_set_009',
      { imageIds: ['wadors:image-1', 'wadors:image-2'] }
    );
    expect(load).toHaveBeenCalled();
    expect(openCase).toHaveBeenCalledWith({
      caseId: 'case_009',
      referenceVolumeId: 'cornerstoneStreamingImageVolume:display_set_009',
      viewportIds: ['viewport_1'],
    });
  });

  it('logs an error rather than throwing when the extension is missing', () => {
    const services = makeServicesManager(null); // extension not loaded
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mode = modeFactory({
      modeConfiguration: { sessionSearch: '?reviewer=R03&condition=C2' },
    });
    expect(() =>
      mode.onModeEnter({
        servicesManager: services,
        extensionManager: {},
        commandsManager: {},
      } as any)
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('onModeExit', () => {
  it('calls closeCase on the uncertainty service', () => {
    const closeCase = jest.fn().mockResolvedValue(undefined);
    const mode = modeFactory();
    mode.onModeExit({
      servicesManager: { services: { uncertaintyService: { closeCase } } },
    } as any);
    expect(closeCase).toHaveBeenCalled();
  });

  it('is a no-op when the service is missing', () => {
    const mode = modeFactory();
    expect(() =>
      mode.onModeExit({
        servicesManager: { services: {} },
      } as any)
    ).not.toThrow();
  });
});

describe('getCommandsModule runtime dependency wiring', () => {
  it('injects mode-built adapters into an already registered uncertainty service', () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn() as any;
    const configureRuntimeDependencies = jest.fn();
    const servicesManager: any = {
      services: {
        uncertaintyService: { configureRuntimeDependencies },
        cornerstoneViewportService: {
          getRenderingEngine: jest.fn(),
          getCornerstoneViewport: jest.fn(),
        },
        segmentationService: {},
      },
    };
    const extensionManager: any = { _appConfig: {} };

    try {
      getCommandsModule({
        servicesManager,
        commandsManager: {},
        extensionManager,
      } as any);

      expect(configureRuntimeDependencies).toHaveBeenCalledWith(
        expect.objectContaining({
          renderer: expect.objectContaining({
            loadForCase: expect.any(Function),
          }),
          exporter: expect.objectContaining({
            exportSegmentationAsNiftiBlob: expect.any(Function),
          }),
          segmentationImporter: expect.objectContaining({
            importSegmentation: expect.any(Function),
          }),
        })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('resolveSegmentationIdForReference', () => {
  const referenceVolumeId = 'cornerstoneStreamingImageVolume:display_set_007';
  const importedSegmentationId = 'uncertainty:monailabel-seg:case_007';

  it('prefers the imported MONAILabel mask for the active case', () => {
    const segmentationService = {
      getSegmentationsByReferenceVolumeId: jest.fn(() => [
        {
          segmentationId: 'generic-active-segmentation',
          representationData: {
            LABELMAP: { referencedVolumeId: referenceVolumeId },
          },
        },
        {
          segmentationId: importedSegmentationId,
          representationData: {
            LABELMAP: { referencedVolumeId: referenceVolumeId },
          },
        },
      ]),
    };

    expect(
      resolveSegmentationIdForReference({
        segmentationService,
        referenceVolumeId,
        preferredSegmentationId: importedSegmentationId,
      })
    ).toBe(importedSegmentationId);
  });

  it('falls back to the reference-volume segmentation when no imported mask is registered', () => {
    const segmentationService = {
      getSegmentationsByReferenceVolumeId: jest.fn(() => [
        {
          id: 'reference-volume-segmentation',
          representationData: {
            Labelmap: { referencedVolumeId: referenceVolumeId },
          },
        },
      ]),
    };

    expect(
      resolveSegmentationIdForReference({
        segmentationService,
        referenceVolumeId,
        preferredSegmentationId: importedSegmentationId,
      })
    ).toBe('reference-volume-segmentation');
  });

  it('uses getSegmentation for the preferred imported mask when available', () => {
    const segmentationService = {
      getSegmentation: jest.fn(() => ({
        segmentationId: importedSegmentationId,
        representationData: {
          LABELMAP: { referencedVolumeId: referenceVolumeId },
        },
      })),
      getActiveSegmentation: jest.fn(() => ({ segmentationId: 'other-active-segmentation' })),
    };

    expect(
      resolveSegmentationIdForReference({
        segmentationService,
        referenceVolumeId,
        preferredSegmentationId: importedSegmentationId,
      })
    ).toBe(importedSegmentationId);
  });

  it('keeps a registered preferred mask even when service metadata omits volume references', () => {
    const segmentationService = {
      getSegmentation: jest.fn(() => ({
        segmentationId: importedSegmentationId,
      })),
      getActiveSegmentation: jest.fn(() => ({ segmentationId: 'other-active-segmentation' })),
    };

    expect(
      resolveSegmentationIdForReference({
        segmentationService,
        referenceVolumeId,
        preferredSegmentationId: importedSegmentationId,
      })
    ).toBe(importedSegmentationId);
  });

  it('returns null when segmentationService is undefined', () => {
    expect(
      resolveSegmentationIdForReference({
        segmentationService: undefined,
        referenceVolumeId,
        preferredSegmentationId: null,
      })
    ).toBeNull();
  });

  it('returns null when segmentationService is null', () => {
    expect(
      resolveSegmentationIdForReference({
        segmentationService: null,
        referenceVolumeId,
        preferredSegmentationId: null,
      })
    ).toBeNull();
  });

  it('returns null when neither OHIF service nor Cornerstone-native state has any segmentation', () => {
    const segmentationService = {};
    // Mock resets: Cornerstone-native state returns empty
    const { __setMockState } = require('../__tests__/mocks/cornerstone-tools');
    __setMockState({ segmentations: [], viewportSegRepresentations: {} });

    expect(
      resolveSegmentationIdForReference({
        segmentationService,
        referenceVolumeId,
        preferredSegmentationId: null,
      })
    ).toBeNull();
  });

  it('finds manual segmentation via Cornerstone3D V2 native state (C0 path)', () => {
    const segmentationService = {};
    const { __setMockState } = require('../__tests__/mocks/cornerstone-tools');
    __setMockState({
      segmentations: [
        {
          segmentationId: 'segmentation:1',
          label: 'Manual annotation',
          representationData: {
            LABELMAP: { volumeId: 'segmentation:1_volume' },
          },
          segments: {},
        },
      ],
      viewportSegRepresentations: {},
    });

    expect(
      resolveSegmentationIdForReference({
        segmentationService,
        referenceVolumeId,
        preferredSegmentationId: null,
      })
    ).toBe('segmentation:1');
  });

  it('picks manual segmentation with matching reference volume over others', () => {
    const segmentationService = {};
    const { __setMockState } = require('../__tests__/mocks/cornerstone-tools');
    __setMockState({
      segmentations: [
        {
          segmentationId: 'manual-seg',
          representationData: {
            LABELMAP: {
              volumeId: 'manual-volume',
              referencedVolumeId: referenceVolumeId,
            },
          },
          segments: {},
        },
      ],
      viewportSegRepresentations: {},
    });

    expect(
      resolveSegmentationIdForReference({
        segmentationService,
        referenceVolumeId,
        preferredSegmentationId: null,
      })
    ).toBe('manual-seg');
  });

  it('falls back to active segmentation from viewport state (Strategy 4)', () => {
    const segmentationService = {};
    const {
      __setMockState,
      segmentation: mockSegmentation,
    } = require('../__tests__/mocks/cornerstone-tools');
    __setMockState({
      segmentations: [],
      viewportSegRepresentations: {
        'viewport-1': [
          {
            segmentationId: 'active-seg-from-vp',
            type: 'Labelmap',
            active: true,
            visible: true,
            segments: {},
            config: {},
          },
        ],
      },
    });
    // Clear getSegmentations & fall through to getViewportIdsWithSegmentation approach
    mockSegmentation.state.getSegmentations.mockReturnValue([]);
    mockSegmentation.state.getSegmentation.mockImplementation((id: string) =>
      id === 'active-seg-from-vp'
        ? {
            segmentationId: 'active-seg-from-vp',
            representationData: { LABELMAP: { volumeId: 'seg-volume' } },
            segments: {},
          }
        : undefined
    );
    mockSegmentation.activeSegmentation.getActiveSegmentation.mockReturnValue({
      segmentationId: 'active-seg-from-vp',
      representationData: { LABELMAP: { volumeId: 'seg-volume' } },
      segments: {},
    });

    expect(
      resolveSegmentationIdForReference({
        segmentationService,
        referenceVolumeId,
        preferredSegmentationId: null,
      })
    ).toBe('active-seg-from-vp');
  });
});
