export const Enums = {
  Events: {
    SEGMENTATION_DATA_MODIFIED: 'SEGMENTATION_DATA_MODIFIED',
    SEGMENTATION_REPRESENTATION_MODIFIED: 'SEGMENTATION_REPRESENTATION_MODIFIED',
  },
  SegmentationRepresentations: {
    Labelmap: 'Labelmap',
  },
};

export const segmentation = {
  addSegmentations: jest.fn(),
  addSegmentationRepresentations: jest.fn(),
  addLabelmapRepresentationToViewportMap: jest.fn(),
  removeSegmentationRepresentation: jest.fn(),
  removeSegmentation: jest.fn(),
  state: {
    removeSegmentation: jest.fn(),
    getSegmentations: jest.fn(),
    getSegmentation: jest.fn(),
    getViewportIdsWithSegmentation: jest.fn(),
  },
  activeSegmentation: {
    getActiveSegmentation: jest.fn(),
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const __setMockState = (overrides: Record<string, any>): void => {
  const defaultState = {
    segmentations: [],
    viewportSegRepresentations: {},
  };
  const mockState = { ...defaultState, ...overrides };

  segmentation.state.getSegmentations.mockReturnValue(mockState.segmentations);
  segmentation.state.getSegmentation.mockImplementation(
    (id: string) => mockState.segmentations.find((s: { segmentationId: string }) => s.segmentationId === id),
  );
  segmentation.state.getViewportIdsWithSegmentation.mockReturnValue(
    Object.keys(mockState.viewportSegRepresentations),
  );
};

export default {
  Enums,
  segmentation,
};
