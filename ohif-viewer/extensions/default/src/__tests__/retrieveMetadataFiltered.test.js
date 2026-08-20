/**
 * Unit tests for retrieveMetadataFiltered (patched).
 *
 * Covers: sync array results (RetrieveMetadataLoaderSync) and async
 * { preLoadData, promises } results (RetrieveMetadataLoaderAsync).
 */
import retrieveMetadataFiltered from '../DicomWebDataSource/utils/retrieveMetadataFiltered';

// Mock RetrieveMetadata to return synthetic results
jest.mock('../DicomWebDataSource/wado/retrieveMetadata', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const RetrieveMetadata = require('../DicomWebDataSource/wado/retrieveMetadata').default as jest.Mock;

function makeSyncResult(instances: Array<Record<string, unknown>>) {
  return instances; // sync loader returns a plain array
}

function makeAsyncResult(preLoadData: unknown[], promises: unknown[]) {
  return { preLoadData, promises };
}

describe('retrieveMetadataFiltered (patched)', () => {
  const client = {};
  const studyUid = '1.2.3';

  beforeEach(() => {
    RetrieveMetadata.mockReset();
  });

  it('aggregates sync loader results (plain arrays) into preLoadData', async () => {
    RetrieveMetadata.mockResolvedValueOnce(makeSyncResult([
      { SOPInstanceUID: '1.1' },
      { SOPInstanceUID: '1.2' },
    ]));
    RetrieveMetadata.mockResolvedValueOnce(makeSyncResult([
      { SOPInstanceUID: '2.1' },
    ]));

    const result = await retrieveMetadataFiltered(
      client,
      studyUid,
      false, // enableStudyLazyLoad = false → sync loader
      { SeriesInstanceUIDs: ['s1', 's2'] },
    );

    expect(result).toEqual({
      preLoadData: [
        { SOPInstanceUID: '1.1' },
        { SOPInstanceUID: '1.2' },
        { SOPInstanceUID: '2.1' },
      ],
      promises: [],
    });
  });

  it('aggregates async loader results ({ preLoadData, promises }) into both arrays', async () => {
    RetrieveMetadata.mockResolvedValueOnce(makeAsyncResult(
      [{ SOPInstanceUID: '1.1' }],
      [Promise.resolve(1)],
    ));
    RetrieveMetadata.mockResolvedValueOnce(makeAsyncResult(
      [{ SOPInstanceUID: '2.1' }, { SOPInstanceUID: '2.2' }],
      [Promise.resolve(2), Promise.resolve(3)],
    ));

    const result = await retrieveMetadataFiltered(
      client,
      studyUid,
      true, // enableStudyLazyLoad = true → async loader
      { SeriesInstanceUIDs: ['s1', 's2'] },
    );

    expect(result.preLoadData).toHaveLength(3);
    expect(result.promises).toHaveLength(3);
  });

  it('handles a mix of sync and async results', async () => {
    // First series: sync → plain array
    RetrieveMetadata.mockResolvedValueOnce(makeSyncResult([
      { SOPInstanceUID: 'sync.1' },
    ]));
    // Second series: async → { preLoadData, promises }
    RetrieveMetadata.mockResolvedValueOnce(makeAsyncResult(
      [{ SOPInstanceUID: 'async.1' }],
      [Promise.resolve('p')],
    ));

    const result = await retrieveMetadataFiltered(
      client,
      studyUid,
      true,
      { SeriesInstanceUIDs: ['s1', 's2'] },
    );

    expect(result.preLoadData).toEqual([
      { SOPInstanceUID: 'sync.1' },
      { SOPInstanceUID: 'async.1' },
    ]);
    expect(result.promises).toHaveLength(1);
  });

  it('handles empty SeriesInstanceUIDs array', async () => {
    const result = await retrieveMetadataFiltered(
      client,
      studyUid,
      false,
      { SeriesInstanceUIDs: [] },
    );
    expect(result).toEqual({ preLoadData: [], promises: [] });
  });

  it('passes series-specific filters to RetrieveMetadata', async () => {
    RetrieveMetadata.mockResolvedValueOnce(makeSyncResult([{ SOPInstanceUID: 'x' }]));

    await retrieveMetadataFiltered(
      client,
      studyUid,
      false,
      {
        SeriesInstanceUIDs: ['s1'],
        extraFilter: 'keep-me',
      },
      'sort',
      'sortFn',
    );

    expect(RetrieveMetadata).toHaveBeenCalledWith(
      client,
      studyUid,
      false,
      { SeriesInstanceUIDs: ['s1'], extraFilter: 'keep-me', seriesInstanceUID: 's1' },
      'sort',
      'sortFn',
    );
  });
});
