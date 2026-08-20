/**
 * Tests for createCornerstoneAdapter.
 *
 * The adapter targets Cornerstone3D V2 and V3 using
 * createAndCacheDerivedVolume, addVolumes, and removeVolumeActors.
 *
 * To make this work without pulling Cornerstone in for real, we use
 * jest.doMock to replace `@cornerstonejs/core` per-test with a fake
 * that records the calls we want to assert on.  This is more
 * heavy-handed than the moduleNameMapper mock, but it lets us assert
 * on specific method dispatches.
 */

import type { CornerstoneAdapter } from '@thesis/extension-uncertainty';

type Recorder = {
  derivedCalls: any[];
  cacheGetCalls: string[];
  cacheRemoveCalls: string[];
  scalarsRef: { current: Float32Array | null };
};

function setupCornerstone(opts: {
  hasDerived: boolean;
}): { rec: Recorder } {
  const rec: Recorder = {
    derivedCalls: [],
    cacheGetCalls: [],
    cacheRemoveCalls: [],
    scalarsRef: { current: null },
  };

  // Reference volume the adapter expects to find in cache.
  const referenceVolume = {
    metadata: { foo: 'bar' },
    dimensions: [32, 32, 16],
    spacing: [1.5, 1.5, 2.0],
    origin: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };

  const volumeLoader: any = {};
  if (opts.hasDerived) {
    volumeLoader.createAndCacheDerivedVolume = jest.fn(
      (refId: string, init: any) => {
        rec.derivedCalls.push({ refId, init });
        const buf = new Float32Array(32 * 32 * 16);
        rec.scalarsRef.current = buf;
        return Promise.resolve({
          scalarData: buf,
          modified: () => {},
        });
      },
    );
  }

  // We use jest.doMock so the call happens per-test; this requires
  // module reset before each call.
  jest.doMock('@cornerstonejs/core', () => ({
    volumeLoader,
    cache: {
      getVolume: jest.fn((id: string) => {
        rec.cacheGetCalls.push(id);
        if (id === 'vol:image') return referenceVolume;
        return null;
      }),
      removeVolumeLoadObject: jest.fn((id: string) => {
        rec.cacheRemoveCalls.push(id);
      }),
    },
  }));

  return { rec };
}

function loadAdapter(): typeof import('../adapter/createCornerstoneAdapter') {
  return require('../adapter/createCornerstoneAdapter');
}

// ---------------------------------------------------------------------------

describe('createCornerstoneAdapter — createDerivedScalarVolume', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('uses createAndCacheDerivedVolume on v2+', async () => {
    const { rec } = setupCornerstone({ hasDerived: true });
    const { createCornerstoneAdapter } = loadAdapter();
    const adapter: CornerstoneAdapter = createCornerstoneAdapter({
      getRenderingEngine: () => null,
      getViewport: () => null,
    });
    const data = new Float32Array(32 * 32 * 16);
    data[0] = 0.42;
    const id = await adapter.createDerivedScalarVolume({
      volumeId: 'vol:entropy',
      referenceVolumeId: 'vol:image',
      scalarData: data,
      dimensions: [32, 32, 16],
      spacing: [1.5, 1.5, 2.0],
    });
    expect(id).toBe('vol:entropy');
    expect(rec.derivedCalls).toHaveLength(1);
    expect(rec.scalarsRef.current?.[0]).toBeCloseTo(0.42, 5);
  });

  it('writes entropy data through a Cornerstone3D v2 voxelManager when no scalarData property exists', async () => {
    const { rec } = setupCornerstone({ hasDerived: true });
    const committed = jest.fn();
    const modified = jest.fn();
    const scalarBuffer = new Float32Array(32 * 32 * 16);

    jest.resetModules();
    jest.doMock('@cornerstonejs/core', () => ({
      volumeLoader: {
        createAndCacheDerivedVolume: jest.fn((refId: string, init: any) => {
          rec.derivedCalls.push({ refId, init });
          return Promise.resolve({
            voxelManager: {
              getScalarData: jest.fn(() => {
                throw new Error('No scalar data available');
              }),
              getCompleteScalarDataArray: jest.fn(() => scalarBuffer),
              setCompleteScalarDataArray: committed,
            },
            modified,
          });
        }),
      },
      cache: {
        getVolume: jest.fn((id: string) => {
          rec.cacheGetCalls.push(id);
          if (id === 'vol:image') {
            return {
              metadata: { foo: 'bar' },
              dimensions: [32, 32, 16],
              spacing: [1.5, 1.5, 2.0],
              origin: [0, 0, 0],
              direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            };
          }
          return null;
        }),
      },
    }));

    const { createCornerstoneAdapter } = loadAdapter();
    const adapter: CornerstoneAdapter = createCornerstoneAdapter({
      getRenderingEngine: () => null,
      getViewport: () => null,
    });
    const data = new Float32Array(32 * 32 * 16);
    data[0] = 0.73;

    await adapter.createDerivedScalarVolume({
      volumeId: 'vol:entropy',
      referenceVolumeId: 'vol:image',
      scalarData: data,
      dimensions: [32, 32, 16],
      spacing: [1.5, 1.5, 2.0],
    });

    expect(scalarBuffer[0]).toBeCloseTo(0.73, 5);
    expect(committed).toHaveBeenCalledWith(scalarBuffer);
    expect(modified).toHaveBeenCalled();
  });

  it('throws when createAndCacheDerivedVolume is not available', async () => {
    setupCornerstone({ hasDerived: false });
    const { createCornerstoneAdapter } = loadAdapter();
    const adapter = createCornerstoneAdapter({
      getRenderingEngine: () => null, getViewport: () => null,
    });
    await expect(adapter.createDerivedScalarVolume({
      volumeId: 'vol:entropy',
      referenceVolumeId: 'vol:image',
      scalarData: new Float32Array(10),
      dimensions: [32, 32, 16],
      spacing: [1.5, 1.5, 2.0],
    })).rejects.toThrow(/createAndCacheDerivedVolume/);
  });

  it('throws when reference volume is not in cache', async () => {
    setupCornerstone({ hasDerived: true });
    const { createCornerstoneAdapter } = loadAdapter();
    const adapter = createCornerstoneAdapter({
      getRenderingEngine: () => null, getViewport: () => null,
    });
    await expect(adapter.createDerivedScalarVolume({
      volumeId: 'vol:entropy',
      referenceVolumeId: 'vol:not_loaded',
      scalarData: new Float32Array(10),
      dimensions: [32, 32, 16],
      spacing: [1.5, 1.5, 2.0],
    })).rejects.toThrow(/not in cache/);
  });

  it('is idempotent: skips creation when the volume id is already cached', async () => {
    const { rec } = setupCornerstone({ hasDerived: true });
    // After the first call, the cache.getVolume should claim the
    // entropy volume already exists.  Patch the mock to return a truthy
    // value for the entropy id.
    jest.resetModules();
    jest.doMock('@cornerstonejs/core', () => ({
      volumeLoader: {
        createAndCacheDerivedVolume: jest.fn(),
      },
      cache: {
        getVolume: jest.fn((id: string) => {
          rec.cacheGetCalls.push(id);
          // Both image and entropy already cached.
          return id === 'vol:image' ? { metadata: {} } : { metadata: {} };
        }),
      },
    }));
    const { createCornerstoneAdapter: factory } = loadAdapter();
    const adapter = factory({
      getRenderingEngine: () => null, getViewport: () => null,
    });
    const id = await adapter.createDerivedScalarVolume({
      volumeId: 'vol:entropy',
      referenceVolumeId: 'vol:image',
      scalarData: new Float32Array(10),
      dimensions: [32, 32, 16],
      spacing: [1.5, 1.5, 2.0],
    });
    expect(id).toBe('vol:entropy');
    // No derived volume was created — early return on cache hit.
    expect(
      (require('@cornerstonejs/core').volumeLoader.createAndCacheDerivedVolume as jest.Mock).mock.calls,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Viewport interactions
// ---------------------------------------------------------------------------

describe('createCornerstoneAdapter — viewport ops', () => {
  beforeEach(() => jest.resetModules());

  function buildAdapterWithViewport(viewport: any) {
    setupCornerstone({ hasDerived: true });
    const { createCornerstoneAdapter } = loadAdapter();
    return createCornerstoneAdapter({
      getRenderingEngine: () => ({
        renderViewports: jest.fn(),
        render: jest.fn(),
      }),
      getViewport: (id: string) => (id === 'vp1' ? viewport : null),
    });
  }

  it('addVolumeToViewports configures and shows the heatmap actor atomically', async () => {
    const property = {
      setRGBTransferFunction: jest.fn(),
      setScalarOpacity: jest.fn(),
      setInterpolationTypeToLinear: jest.fn(),
      setIndependentComponents: jest.fn(),
    };
    const setVisibility = jest.fn();
    const viewport = { addVolumes: jest.fn().mockResolvedValue(undefined) };
    const adapter = buildAdapterWithViewport(viewport);
    await (adapter.addVolumeToViewports as any)({
      volumeId: 'v',
      viewportIds: ['vp1'],
      visible: true,
      transfer: {
        color: [{ x: 0, r: 0, g: 0, b: 0 }, { x: 1, r: 1, g: 1, b: 1 }],
        opacity: [{ x: 0, alpha: 0 }, { x: 1, alpha: 0.6 }],
        meta: { maxEntropy: 1, baseOpacity: 0.6 },
      },
    });

    expect(viewport.addVolumes).toHaveBeenCalledWith([
      expect.objectContaining({
        volumeId: 'v',
        actorUID: 'v',
        visibility: true,
        callback: expect.any(Function),
      }),
    ], true);

    const [{ callback }] = viewport.addVolumes.mock.calls[0][0];
    callback({
      volumeActor: {
        getProperty: () => property,
        setVisibility,
      },
      volumeId: 'v',
    });
    expect(property.setRGBTransferFunction).toHaveBeenCalledTimes(1);
    expect(property.setScalarOpacity).toHaveBeenCalledTimes(1);
    expect(setVisibility).toHaveBeenCalledWith(true);
  });

  it('addVolumeToViewports falls back to setVolumes with the requested visibility', async () => {
    const viewport = {
      setVolumes: jest.fn().mockResolvedValue(undefined),
      getVolumeIds: () => ['existing'],
    };
    const adapter = buildAdapterWithViewport(viewport);
    await (adapter.addVolumeToViewports as any)({
      volumeId: 'v',
      viewportIds: ['vp1'],
      visible: false,
      transfer: {
        color: [{ x: 0, r: 0, g: 0, b: 0 }],
        opacity: [{ x: 0, alpha: 0 }],
        meta: { maxEntropy: 1, baseOpacity: 0.6 },
      },
    });
    expect(viewport.setVolumes).toHaveBeenCalledWith([
      { volumeId: 'existing' },
      expect.objectContaining({
        volumeId: 'v',
        actorUID: 'v',
        visibility: false,
        callback: expect.any(Function),
      }),
    ], true);
  });

  it('setVolumeVisible calls actor.setVisibility', () => {
    const setVisibility = jest.fn();
    const viewport = {
      getActor: jest.fn().mockReturnValue({
        actor: { setVisibility },
      }),
    };
    const adapter = buildAdapterWithViewport(viewport);
    adapter.setVolumeVisible({
      volumeId: 'v', viewportIds: ['vp1'], visible: true,
    });
    expect(setVisibility).toHaveBeenCalledWith(true);
  });

  it('applyTransferFunctions sets RGB and opacity on the actor property', () => {
    const property = {
      setRGBTransferFunction: jest.fn(),
      setScalarOpacity: jest.fn(),
      setInterpolationTypeToLinear: jest.fn(),
      setIndependentComponents: jest.fn(),
    };
    const viewport = {
      getActor: () => ({ actor: { getProperty: () => property } }),
    };
    const adapter = buildAdapterWithViewport(viewport);
    adapter.applyTransferFunctions({
      volumeId: 'v',
      viewportIds: ['vp1'],
      transfer: {
        color: [{ x: 0, r: 0, g: 0, b: 0 }, { x: 1, r: 1, g: 1, b: 1 }],
        opacity: [{ x: 0, alpha: 0 }, { x: 1, alpha: 0.5 }],
        meta: { maxEntropy: 1, baseOpacity: 0.5 },
      },
    });
    expect(property.setRGBTransferFunction).toHaveBeenCalledTimes(1);
    expect(property.setScalarOpacity).toHaveBeenCalledTimes(1);
  });

  it('removeVolume prefers removeVolumeActors when available', async () => {
    const viewport = {
      removeVolumeActors: jest.fn(),
    };
    const adapter = buildAdapterWithViewport(viewport);
    await adapter.removeVolume({ volumeId: 'v', viewportIds: ['vp1'] });
    expect(viewport.removeVolumeActors).toHaveBeenCalledWith(['v'], false);
  });

  it('renderViewports forwards to the rendering engine', () => {
    const re = { renderViewports: jest.fn() };
    setupCornerstone({ hasDerived: true });
    const { createCornerstoneAdapter } = loadAdapter();
    const adapter = createCornerstoneAdapter({
      getRenderingEngine: () => re,
      getViewport: () => null,
    });
    adapter.renderViewports(['vp1', 'vp2']);
    expect(re.renderViewports).toHaveBeenCalledWith(['vp1', 'vp2']);
  });
});
