/**
 * Tests for createSegmentationExportAdapter.
 *
 * Mirrors the pattern from createCornerstoneAdapter.test.ts: we use
 * `jest.doMock` to substitute fake `@cornerstonejs/core` and
 * `@cornerstonejs/tools` modules per-test so we can exercise the
 * v2+ (segmentation.state.getSegmentation) Cornerstone API.
 *
 * The adapter has two distinct concerns and we test them separately:
 *
 *   1. Reading the labelmap volume out of Cornerstone's state
 *   2. Serialising the labelmap into a minimal NIfTI-1 byte stream —
 *      this is just a function over the volume metadata, but it's
 *      where bugs in dimension/spacing handling would silently corrupt
 *      every reviewer submission, so we verify the header bytes.
 */

import type { SegmentationExportAdapter } from '@thesis/extension-uncertainty';

type Recorder = {
  segIdCalls: string[];
};

function setupMockFallback(opts: {
  /** What `getSegmentation` should return.  null = no segmentation found. */
  segmentation: unknown;
  /** The cached volume the segmentation refers to.  null = not in cache. */
  cachedVolume: unknown;
}): { rec: Recorder } {
  const rec: Recorder = { segIdCalls: [] };
  jest.doMock('@cornerstonejs/core', () => ({
    cache: {
      getVolume: jest.fn((id: string) => {
        rec.segIdCalls.push(id);
        return opts.cachedVolume;
      }),
    },
    volumeLoader: {},
  }));
  jest.doMock('@cornerstonejs/tools', () => ({
    segmentation: {
      state: {
        getSegmentation: jest.fn(() => opts.segmentation),
      },
    },
  }));
  return { rec };
}

function setupEmpty(): void {
  // No V2+ APIs are available — the adapter should log a
  // warning and return null without throwing.
  jest.doMock('@cornerstonejs/core', () => ({
    cache: { getVolume: jest.fn() },
    volumeLoader: {},
  }));
  jest.doMock('@cornerstonejs/tools', () => ({}));
}

function loadAdapter() {
  return require('../adapter/createSegmentationExportAdapter');
}

// Volume that resembles what Cornerstone3D v2+ caches.
function makeFakeVolume(scalarData: Uint8Array | Int16Array | Uint16Array) {
  return {
    scalarData,
    dimensions: [4, 4, 4] as [number, number, number],
    spacing: [1.5, 1.5, 2.0] as [number, number, number],
    origin: [-10, -20, -30] as [number, number, number],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };
}

// ---------------------------------------------------------------------------
// Reading the labelmap (version dispatch)
// ---------------------------------------------------------------------------

describe('createSegmentationExportAdapter — version dispatch', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('returns null when no segmentationId is found for the reference', async () => {
    setupMockFallback({ segmentation: null, cachedVolume: null });
    const { createSegmentationExportAdapter } = loadAdapter();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter: SegmentationExportAdapter = createSegmentationExportAdapter({
      getSegmentationIdForReference: () => null,
    });
    const blob = await adapter.exportSegmentationAsNiftiBlob({
      caseId: 'c', referenceVolumeId: 'vol:image',
    });
    expect(blob).toBeNull();
    warn.mockRestore();
  });

  it('v2+: reads scalarData from the cached volume named by the segmentation', async () => {
    const data = new Uint8Array(64);
    data[10] = 1;
    setupMockFallback({
      segmentation: {
        representationData: {
          LABELMAP: { volumeId: 'vol:seg' },
        },
      },
      cachedVolume: makeFakeVolume(data),
    });
    const { createSegmentationExportAdapter } = loadAdapter();
    const adapter = createSegmentationExportAdapter({
      getSegmentationIdForReference: () => 'seg-1',
    });
    const blob = await adapter.exportSegmentationAsNiftiBlob({
      caseId: 'c', referenceVolumeId: 'vol:image',
    });
    expect(blob).not.toBeNull();
    expect(blob!.size).toBeGreaterThan(348);   // header + at least one byte
  });

  it('v2+: tolerates `Labelmap` (capitalised differently)', async () => {
    setupMockFallback({
      segmentation: {
        representationData: {
          Labelmap: { volumeId: 'vol:seg' },
        },
      },
      cachedVolume: makeFakeVolume(new Uint8Array(64)),
    });
    const { createSegmentationExportAdapter } = loadAdapter();
    const adapter = createSegmentationExportAdapter({
      getSegmentationIdForReference: () => 'seg-1',
    });
    const blob = await adapter.exportSegmentationAsNiftiBlob({
      caseId: 'c', referenceVolumeId: 'vol:image',
    });
    expect(blob).not.toBeNull();
  });

  it('v2+: returns null when the segmentation volume is not cached', async () => {
    setupMockFallback({
      segmentation: {
        representationData: { LABELMAP: { volumeId: 'vol:seg' } },
      },
      cachedVolume: null,
    });
    const { createSegmentationExportAdapter } = loadAdapter();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = createSegmentationExportAdapter({
      getSegmentationIdForReference: () => 'seg-1',
    });
    const blob = await adapter.exportSegmentationAsNiftiBlob({
      caseId: 'c', referenceVolumeId: 'vol:image',
    });
    expect(blob).toBeNull();
    warn.mockRestore();
  });

  it('v2+: returns null when the segmentation has no representationData', async () => {
    setupMockFallback({
      segmentation: { },   // no representationData at all
      cachedVolume: null,
    });
    const { createSegmentationExportAdapter } = loadAdapter();
    const adapter = createSegmentationExportAdapter({
      getSegmentationIdForReference: () => 'seg-1',
    });
    const blob = await adapter.exportSegmentationAsNiftiBlob({
      caseId: 'c', referenceVolumeId: 'vol:image',
    });
    expect(blob).toBeNull();
  });

  it('returns null and warns when V2+ API is unavailable', async () => {
    setupEmpty();
    const { createSegmentationExportAdapter } = loadAdapter();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = createSegmentationExportAdapter({
      getSegmentationIdForReference: () => 'seg-1',
    });
    const blob = await adapter.exportSegmentationAsNiftiBlob({
      caseId: 'c', referenceVolumeId: 'vol:image',
    });
    expect(blob).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// NIfTI header serialisation
// ---------------------------------------------------------------------------

describe('createSegmentationExportAdapter — NIfTI header bytes', () => {
  // jsdom's `Blob` polyfill predates the WHATWG spec and lacks
  // `.arrayBuffer()`.  Substitute Node's native Blob (available since
  // Node 18) for these tests so we can round-trip the bytes back out.
  // Restore jsdom's Blob after the suite so the rest of the file
  // remains untouched.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let savedBlob: any;
  beforeAll(() => {
    savedBlob = (globalThis as any).Blob;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (globalThis as any).Blob = require('node:buffer').Blob;
  });
  afterAll(() => {
    (globalThis as any).Blob = savedBlob;
  });

  beforeEach(() => jest.resetModules());

  /** Helper: read out the produced NIfTI as bytes. */
  async function exportToBytes(
    scalarData: Uint8Array | Int16Array | Uint16Array,
  ): Promise<{ header: Uint8Array; full: Uint8Array }> {
    setupMockFallback({
      segmentation: {
        representationData: { LABELMAP: { volumeId: 'vol:seg' } },
      },
      cachedVolume: makeFakeVolume(scalarData),
    });
    const { createSegmentationExportAdapter } = loadAdapter();
    const adapter = createSegmentationExportAdapter({
      getSegmentationIdForReference: () => 'seg-1',
    });
    const blob = await adapter.exportSegmentationAsNiftiBlob({
      caseId: 'c', referenceVolumeId: 'vol:image',
    });
    expect(blob).not.toBeNull();
    const buf = new Uint8Array(await blob!.arrayBuffer());
    return { header: buf.slice(0, 348), full: buf };
  }

  it('writes sizeof_hdr=348 and the magic "n+1" marker', async () => {
    const { header } = await exportToBytes(new Uint8Array(64));
    const dv = new DataView(
      header.buffer, header.byteOffset, header.byteLength,
    );
    expect(dv.getInt32(0, true)).toBe(348);
    // Magic bytes at offset 344: 'n','+','1','\0'
    expect(header[344]).toBe(0x6e);   // 'n'
    expect(header[345]).toBe(0x2b);   // '+'
    expect(header[346]).toBe(0x31);   // '1'
    expect(header[347]).toBe(0x00);
  });

  it('writes dim[0]=3 and dim[1..3] = volume dimensions', async () => {
    const { header } = await exportToBytes(new Uint8Array(64));
    const dv = new DataView(
      header.buffer, header.byteOffset, header.byteLength,
    );
    expect(dv.getInt16(40, true)).toBe(3);
    expect(dv.getInt16(42, true)).toBe(4);
    expect(dv.getInt16(44, true)).toBe(4);
    expect(dv.getInt16(46, true)).toBe(4);
  });

  it('writes pixdim[1..3] = spacing', async () => {
    const { header } = await exportToBytes(new Uint8Array(64));
    const dv = new DataView(
      header.buffer, header.byteOffset, header.byteLength,
    );
    expect(dv.getFloat32(80, true)).toBeCloseTo(1.5, 5);
    expect(dv.getFloat32(84, true)).toBeCloseTo(1.5, 5);
    expect(dv.getFloat32(88, true)).toBeCloseTo(2.0, 5);
  });

  it('uses datatype=2 (UINT8) and bitpix=8 for Uint8Array', async () => {
    const { header } = await exportToBytes(new Uint8Array(64));
    const dv = new DataView(
      header.buffer, header.byteOffset, header.byteLength,
    );
    expect(dv.getInt16(70, true)).toBe(2);     // datatype = NIFTI_TYPE_UINT8
    expect(dv.getInt16(72, true)).toBe(8);     // bitpix
  });

  it('uses datatype=4 (INT16) for Int16Array', async () => {
    const { header } = await exportToBytes(new Int16Array(64));
    const dv = new DataView(
      header.buffer, header.byteOffset, header.byteLength,
    );
    expect(dv.getInt16(70, true)).toBe(4);     // INT16
    expect(dv.getInt16(72, true)).toBe(16);
  });

  it('uses datatype=512 (UINT16) for Uint16Array', async () => {
    const { header } = await exportToBytes(new Uint16Array(64));
    const dv = new DataView(
      header.buffer, header.byteOffset, header.byteLength,
    );
    expect(dv.getInt16(70, true)).toBe(512);
    expect(dv.getInt16(72, true)).toBe(16);
  });

  it('writes vox_offset=348 and the body follows directly', async () => {
    const data = new Uint8Array(64);
    data[5] = 99;     // sentinel
    const { header, full } = await exportToBytes(data);
    const dv = new DataView(
      header.buffer, header.byteOffset, header.byteLength,
    );
    expect(dv.getFloat32(108, true)).toBe(348);
    // The body should start at byte 348 and contain our sentinel
    // at the same offset within the data.
    expect(full[348 + 5]).toBe(99);
    // Total size = header + body
    expect(full.length).toBe(348 + 64);
  });

  it('writes sform_code=1 and an sform that combines spacing+origin', async () => {
    const { header } = await exportToBytes(new Uint8Array(64));
    const dv = new DataView(
      header.buffer, header.byteOffset, header.byteLength,
    );
    expect(dv.getInt16(252, true)).toBe(0);    // qform_code
    expect(dv.getInt16(254, true)).toBe(1);    // sform_code = scanner anatomical

    // sform row 0: [direction[0]*sx, direction[3]*sy, direction[6]*sz, origin[0]]
    // For our identity direction & spacing (1.5, 1.5, 2.0): [1.5, 0, 0, -10]
    expect(dv.getFloat32(280, true)).toBeCloseTo(1.5, 5);
    expect(dv.getFloat32(284, true)).toBeCloseTo(0, 5);
    expect(dv.getFloat32(288, true)).toBeCloseTo(0, 5);
    expect(dv.getFloat32(292, true)).toBeCloseTo(-10, 5);
    // Row 1: [0, 1.5, 0, -20]
    expect(dv.getFloat32(296, true)).toBeCloseTo(0, 5);
    expect(dv.getFloat32(300, true)).toBeCloseTo(1.5, 5);
    expect(dv.getFloat32(304, true)).toBeCloseTo(0, 5);
    expect(dv.getFloat32(308, true)).toBeCloseTo(-20, 5);
    // Row 2: [0, 0, 2.0, -30]
    expect(dv.getFloat32(312, true)).toBeCloseTo(0, 5);
    expect(dv.getFloat32(316, true)).toBeCloseTo(0, 5);
    expect(dv.getFloat32(320, true)).toBeCloseTo(2.0, 5);
    expect(dv.getFloat32(324, true)).toBeCloseTo(-30, 5);
  });

  it('preserves the scalar data byte-for-byte in the body', async () => {
    const data = new Uint8Array(64);
    for (let i = 0; i < 64; i++) data[i] = i % 7;
    const { full } = await exportToBytes(data);
    for (let i = 0; i < 64; i++) {
      expect(full[348 + i]).toBe(i % 7);
    }
  });

  it('copies SharedArrayBuffer-backed scalar data before constructing the Blob', async () => {
    const NodeBlob = require('node:buffer').Blob;
    const previousBlob = (globalThis as any).Blob;
    class StrictBlob extends NodeBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        for (const part of parts ?? []) {
          if (ArrayBuffer.isView(part) && part.buffer instanceof SharedArrayBuffer) {
            throw new TypeError(
              "Failed to construct 'Blob': The provided ArrayBufferView value must not be shared.",
            );
          }
        }
        super(parts, options);
      }
    }
    (globalThis as any).Blob = StrictBlob;
    const shared = new SharedArrayBuffer(64);
    const data = new Uint8Array(shared);
    for (let i = 0; i < data.length; i++) data[i] = (i * 3) % 11;

    try {
      const { full } = await exportToBytes(data);

      expect(full.length).toBe(348 + 64);
      for (let i = 0; i < 64; i++) {
        expect(full[348 + i]).toBe((i * 3) % 11);
      }
    } finally {
      (globalThis as any).Blob = previousBlob;
    }
  });
});
