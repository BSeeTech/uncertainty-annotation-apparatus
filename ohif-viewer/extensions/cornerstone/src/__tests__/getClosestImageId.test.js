/**
 * Unit tests for the patched getClosestImageId logic.
 *
 * Covers: regular spacing, irregular spacing, absent position metadata,
 * and the three-tier fallback (half-spacing → absolute closest → middle image).
 *
 * The patched function is inlined here because Jest cannot transform ESM
 * modules in node_modules/@cornerstonejs.
 */

import { vec3 } from 'gl-matrix';

// ---------------------------------------------------------------------------
// Inlined patched getClosestImageId (from @cornerstonejs/core 3.33.5 patch)
// ---------------------------------------------------------------------------

const EPSILON = 1e-6;

function getSpacingInNormalDirection({ direction, spacing }, viewPlaneNormal) {
  const kVector = direction.slice(6, 9);
  const dotProduct = vec3.dot(kVector, viewPlaneNormal);
  return Math.abs(spacing[2] * dotProduct); // simplified for axial volumes
}

function getClosestImageId(imageVolume, worldPos, viewPlaneNormal, options) {
  const { direction, spacing, imageIds } = imageVolume;
  const { ignoreSpacing = false } = options || {};
  if (!imageIds?.length) {
    return;
  }
  const kVector = direction.slice(6, 9);
  const dotProduct = vec3.dot(kVector, viewPlaneNormal);
  if (Math.abs(dotProduct) < 1 - EPSILON) {
    return;
  }
  let halfSpacingInNormalDirection;
  if (!ignoreSpacing) {
    const spacingInNormalDirection = getSpacingInNormalDirection(
      { direction, spacing },
      viewPlaneNormal
    );
    halfSpacingInNormalDirection = spacingInNormalDirection / 2;
  }
  let closestImageId;
  let closestImageIdAbsolute;
  let minDistance = Infinity;
  let minDistanceAbsolute = Infinity;
  let totalImages = 0;
  let missingPositionCount = 0;
  let missingImagePlaneCount = 0;
  for (let i = 0; i < imageIds.length; i++) {
    const imageId = imageIds[i];
    totalImages++;
    const imagePlaneModule = metaData.get('imagePlaneModule', imageId);
    if (!imagePlaneModule) {
      missingImagePlaneCount++;
      continue;
    }
    if (!imagePlaneModule.imagePositionPatient) {
      missingPositionCount++;
      continue;
    }
    const { imagePositionPatient } = imagePlaneModule;
    const dir = vec3.create();
    vec3.sub(dir, worldPos, imagePositionPatient);
    const distance = Math.abs(vec3.dot(dir, viewPlaneNormal));
    if (ignoreSpacing) {
      if (distance < minDistance) {
        minDistance = distance;
        closestImageId = imageId;
      }
    } else {
      if (distance < minDistanceAbsolute) {
        minDistanceAbsolute = distance;
        closestImageIdAbsolute = imageId;
      }
      if (distance < halfSpacingInNormalDirection && distance < minDistance) {
        minDistance = distance;
        closestImageId = imageId;
      }
    }
  }
  if (closestImageId === undefined) {
    if (closestImageIdAbsolute !== undefined) {
      closestImageId = closestImageIdAbsolute;
      warn('No imageId found within half-spacing — falling back to the absolute closest image.');
    } else {
      warn(
        'getClosestImageId: no imageId with valid position metadata. ' +
          `total=${totalImages} missingImagePlane=${missingImagePlaneCount} ` +
          `missingPosition=${missingPositionCount}. Falling back to middle image.`
      );
      closestImageId = imageIds[Math.floor(imageIds.length / 2)];
    }
  }
  return closestImageId;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mockImagePlaneModules: Record<
  string,
  { imagePositionPatient?: number[] } | null
> = {};
const warn = jest.fn();

const metaData = {
  get: (_type: string, imageId: string) => mockImagePlaneModules[imageId],
};

function makeVolume(
  direction: number[],
  spacing: number[],
  imageIds: string[]
): { direction: number[]; spacing: number[]; imageIds: string[] } {
  return { direction, spacing, imageIds };
}

function posAtZ(z: number, kVector: number[]): number[] {
  return [kVector[0] * z, kVector[1] * z, kVector[2] * z];
}

const axialDirection = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // kVector = [0,0,1]
const axialViewPlaneNormal = [0, 0, 1];

beforeEach(() => {
  Object.keys(mockImagePlaneModules).forEach((k) => delete mockImagePlaneModules[k]);
  warn.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getClosestImageId (patched)', () => {
  // -------------------------------------------------------------------
  // Tier 1: regular spacing — half-spacing match
  // -------------------------------------------------------------------
  it('selects the closest image within half-spacing (regular spacing)', () => {
    const imageIds = ['img:0', 'img:1', 'img:2', 'img:3', 'img:4'];
    for (let i = 0; i < imageIds.length; i++) {
      mockImagePlaneModules[imageIds[i]] = {
        imagePositionPatient: posAtZ(i * 2.0, [0, 0, 1]),
      };
    }
    const volume = makeVolume(axialDirection, [1, 1, 2.0], imageIds);
    const result = getClosestImageId(volume, [0, 0, 2.1], axialViewPlaneNormal);
    expect(result).toBe('img:1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('selects the middle image when worldPos is exactly between two slices', () => {
    const imageIds = ['img:0', 'img:1', 'img:2'];
    for (let i = 0; i < imageIds.length; i++) {
      mockImagePlaneModules[imageIds[i]] = {
        imagePositionPatient: posAtZ(i, [0, 0, 1]),
      };
    }
    const volume = makeVolume(axialDirection, [1, 1, 1.0], imageIds);
    const result = getClosestImageId(volume, [0, 0, 1.0], axialViewPlaneNormal);
    expect(result).toBe('img:1');
    expect(warn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // Tier 2: irregular spacing — fall back to absolute closest
  // -------------------------------------------------------------------
  it('falls back to absolute closest when spacing is irregular', () => {
    const imageIds = ['img:0', 'img:1', 'img:2'];
    // Images at z=0, 50, 100 — evenly spaced but volume spacing claims 2.0
    // so halfSpacing = 1.0. Camera at z=30 is not within 1.0 of any image,
    // so the half-spacing filter rejects all. Fallback picks img:1 (at z=50).
    mockImagePlaneModules['img:0'] = { imagePositionPatient: posAtZ(0, [0, 0, 1]) };
    mockImagePlaneModules['img:1'] = { imagePositionPatient: posAtZ(50, [0, 0, 1]) };
    mockImagePlaneModules['img:2'] = { imagePositionPatient: posAtZ(100, [0, 0, 1]) };
    const volume = makeVolume(axialDirection, [1, 1, 2.0], imageIds);
    const result = getClosestImageId(volume, [0, 0, 30], axialViewPlaneNormal);
    expect(result).toBe('img:1');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to the absolute closest image')
    );
  });

  // -------------------------------------------------------------------
  // Tier 3: absent position metadata — fall back to middle image
  // -------------------------------------------------------------------
  it('falls back to middle image when no image has position metadata', () => {
    const imageIds = ['img:a', 'img:b', 'img:c', 'img:d', 'img:e'];
    for (const id of imageIds) mockImagePlaneModules[id] = null;
    const volume = makeVolume(axialDirection, [1, 1, 1.0], imageIds);
    const result = getClosestImageId(volume, [0, 0, 2.5], axialViewPlaneNormal);
    expect(result).toBe('img:c');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Falling back to middle image')
    );
  });

  it('falls back to middle image when images have imagePlaneModule but no position', () => {
    const imageIds = ['img:a', 'img:b', 'img:c'];
    mockImagePlaneModules['img:a'] = { imagePositionPatient: undefined } as any;
    mockImagePlaneModules['img:b'] = { imagePositionPatient: undefined } as any;
    mockImagePlaneModules['img:c'] = { imagePositionPatient: undefined } as any;
    const volume = makeVolume(axialDirection, [1, 1, 1.0], imageIds);
    const result = getClosestImageId(volume, [0, 0, 0.5], axialViewPlaneNormal);
    expect(result).toBe('img:b');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Falling back to middle image')
    );
  });

  // -------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------
  it('returns undefined when imageIds is empty', () => {
    const volume = makeVolume(axialDirection, [1, 1, 1.0], []);
    const result = getClosestImageId(volume, [0, 0, 0], axialViewPlaneNormal);
    expect(result).toBeUndefined();
  });

  it('returns undefined when viewPlaneNormal is not aligned with kVector', () => {
    const volume = makeVolume(axialDirection, [1, 1, 1.0], ['img:0']);
    mockImagePlaneModules['img:0'] = { imagePositionPatient: [0, 0, 0] };
    const result = getClosestImageId(volume, [0, 0, 0], [1, 0, 0]);
    expect(result).toBeUndefined();
  });

  it('ignoreSpacing option bypasses half-spacing and uses absolute closest', () => {
    const imageIds = ['img:0', 'img:1', 'img:2'];
    mockImagePlaneModules['img:0'] = { imagePositionPatient: posAtZ(0, [0, 0, 1]) };
    mockImagePlaneModules['img:1'] = { imagePositionPatient: posAtZ(20, [0, 0, 1]) };
    mockImagePlaneModules['img:2'] = { imagePositionPatient: posAtZ(100, [0, 0, 1]) };
    const volume = makeVolume(axialDirection, [1, 1, 100.0], imageIds);
    const result = getClosestImageId(volume, [0, 0, 30], axialViewPlaneNormal, {
      ignoreSpacing: true,
    });
    expect(result).toBe('img:1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the only image when there is exactly one with valid position', () => {
    const imageIds = ['img:only'];
    mockImagePlaneModules['img:only'] = {
      imagePositionPatient: posAtZ(5, [0, 0, 1]),
    };
    const volume = makeVolume(axialDirection, [1, 1, 1.0], imageIds);
    const result = getClosestImageId(volume, [0, 0, 5.4], axialViewPlaneNormal);
    expect(result).toBe('img:only');
  });
});
