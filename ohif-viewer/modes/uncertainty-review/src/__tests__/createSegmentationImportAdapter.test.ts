import * as cornerstone from '@cornerstonejs/core';
import * as cstoneTools from '@cornerstonejs/tools';
import { createSegmentationImportAdapter } from '../adapter/createSegmentationImportAdapter';
import { loadNiftiFromUrl } from '@thesis/extension-uncertainty';

jest.mock('@thesis/extension-uncertainty', () => ({
  loadNiftiFromUrl: jest.fn(),
}));

const core = cornerstone as any;
const tools = cstoneTools as any;
const loadNifti = loadNiftiFromUrl as jest.Mock;

describe('createSegmentationImportAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadNifti.mockResolvedValue({
      data: new Float32Array([0, 1]),
      dimensions: [1, 1, 2],
      spacing: [1, 1, 1],
      affine: new Float64Array(16),
      dataMin: 0,
      dataMax: 1,
    });
    tools.segmentation.addSegmentationRepresentations.mockResolvedValue(undefined);
  });

  it('creates and loads the missing reference volume from display-set imageIds before importing', async () => {
    const referenceVolumeId = 'cornerstoneStreamingImageVolume:display_set_1';
    const referenceVolume = {
      volumeId: referenceVolumeId,
      dimensions: [1, 1, 2],
      spacing: [1, 1, 1],
      origin: [0, 0, 0],
      direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      metadata: {},
      getScalarData: () => new Uint16Array([10, 20]),
    };
    const segmentationVolume = {
      volumeId: 'uncertainty:monailabel-mask:case_1',
      dimensions: [1, 1, 2],
      getScalarData: () => new Uint8Array(2),
      modified: jest.fn(),
    };
    const load = jest.fn().mockResolvedValue(undefined);

    core.cache.getVolume.mockImplementation((volumeId: string) => {
      if (volumeId === referenceVolumeId) return null;
      if (volumeId === 'uncertainty:monailabel-mask:case_1') return null;
      return null;
    });
    core.volumeLoader.createAndCacheVolume.mockResolvedValue({
      ...referenceVolume,
      load,
    });
    core.volumeLoader.createAndCacheDerivedLabelmapVolume
      .mockResolvedValue(segmentationVolume);

    const adapter = createSegmentationImportAdapter({
      servicesManager: {
        services: {
          displaySetService: {
            getDisplaySets: () => [{
              displaySetInstanceUID: 'display_set_1',
              imageIds: ['wadors:image-1', 'wadors:image-2'],
            }],
          },
        },
      } as any,
    });

    await adapter.importSegmentation({
      caseId: 'case_1',
      segmentationUrl: 'http://localhost:58050/files/case_1/segmentation.nii.gz',
      referenceVolumeId,
      viewportIds: ['viewport_1'],
    });

    expect(core.volumeLoader.createAndCacheVolume).toHaveBeenCalledWith(
      referenceVolumeId,
      { imageIds: ['wadors:image-1', 'wadors:image-2'] },
    );
    expect(load).toHaveBeenCalled();
    expect(core.volumeLoader.createAndCacheDerivedLabelmapVolume)
      .toHaveBeenCalledWith(referenceVolumeId, expect.objectContaining({
        volumeId: 'uncertainty:monailabel-mask:case_1',
      }));
    expect(tools.segmentation.addSegmentations).toHaveBeenCalledWith([
      expect.objectContaining({
        segmentationId: 'uncertainty:monailabel-seg:case_1',
        hydrated: true,
        displaySetInstanceUID: 'display_set_1',
        representationData: expect.objectContaining({
          LABELMAP: expect.objectContaining({
            volumeId: 'uncertainty:monailabel-mask:case_1',
            referencedVolumeId: referenceVolumeId,
          }),
        }),
      }),
    ]);
    expect(tools.segmentation.addLabelmapRepresentationToViewportMap)
      .toHaveBeenCalledWith({
        viewport_1: [expect.objectContaining({
          segmentationId: 'uncertainty:monailabel-seg:case_1',
          type: 'Labelmap',
        })],
      });
  });

  it('writes label data through a Cornerstone3D v2 voxelManager when no scalarData property exists', async () => {
    const referenceVolumeId = 'cornerstoneStreamingImageVolume:display_set_2';
    const committed = jest.fn();
    const modified = jest.fn();
    const voxelManager = {
      getScalarData: jest.fn(() => {
        throw new Error('No scalar data available');
      }),
      getCompleteScalarDataArray: jest.fn(() => new Uint8Array(2)),
      setCompleteScalarDataArray: committed,
    };
    const segmentationVolume = {
      volumeId: 'uncertainty:monailabel-mask:case_2',
      dimensions: [1, 1, 2],
      voxelManager,
      modified,
    };

    core.cache.getVolume.mockImplementation((volumeId: string) => {
      if (volumeId === referenceVolumeId) {
        return {
          volumeId: referenceVolumeId,
          dimensions: [1, 1, 2],
          spacing: [1, 1, 1],
          origin: [0, 0, 0],
          direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          metadata: {},
          imageIds: ['wadors:image-1', 'wadors:image-2'],
        };
      }
      return null;
    });
    core.volumeLoader.createAndCacheDerivedLabelmapVolume
      .mockResolvedValue(segmentationVolume);

    const adapter = createSegmentationImportAdapter();

    await adapter.importSegmentation({
      caseId: 'case_2',
      segmentationUrl: 'http://localhost:58050/files/case_2/segmentation.nii.gz',
      referenceVolumeId,
      viewportIds: ['viewport_1'],
    });

    expect(voxelManager.getScalarData).toHaveBeenCalled();
    expect(voxelManager.getCompleteScalarDataArray).toHaveBeenCalled();
    expect(committed).toHaveBeenCalledWith(new Uint8Array([0, 1]));
    expect(modified).toHaveBeenCalled();
  });
});
