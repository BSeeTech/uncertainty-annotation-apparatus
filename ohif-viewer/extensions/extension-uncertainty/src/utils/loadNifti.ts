/**
 * Lightweight NIfTI loader.
 *
 * Wraps `nifti-reader-js` so the rest of the extension only has to
 * deal with a typed result rather than the raw header / image
 * separation that nifti-reader-js exposes.
 *
 * We pull only the fields needed by the heatmap renderer:
 *   - the scalar volume as `Float32Array`,
 *   - dimensions, spacing, and the affine,
 *   - a `dataMin` / `dataMax` so the colormap range can be auto-fit
 *     when the caller doesn't pass an explicit `maxEntropy`.
 *
 * The implementation is small enough that we could hand-roll the
 * NIfTI header parsing in a pinch, but the dependency is tiny (~20 KB)
 * and well-tested.
 */

// `nifti-reader-js` ships only a default export with several functions.
// We import the type as `any` because the package does not ship its own
// type definitions and we don't want to write a full DT for thesis code.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as niftiReader from 'nifti-reader-js';

export interface NiftiVolume {
  /** Scalar data, always as Float32Array. */
  data: Float32Array;
  /** [X, Y, Z] dimensions. */
  dimensions: [number, number, number];
  /** Voxel spacing in mm, [X, Y, Z]. */
  spacing: [number, number, number];
  /** 4×4 affine, row-major, in homogeneous coordinates. */
  affine: Float64Array;
  /** Empirical min and max of `data`. */
  dataMin: number;
  dataMax: number;
}

/**
 * Fetch a `.nii.gz` from `url` and return a typed volume.
 *
 * `fetchImpl` is exposed so tests can inject a stub fetch returning a
 * pre-baked ArrayBuffer.
 */
export async function loadNiftiFromUrl(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  timeoutMs = 120_000,
): Promise<NiftiVolume> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs,
  );

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch NIfTI ${url}: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    throw new Error(`Failed to fetch NIfTI ${url}: ${resp.status} ${resp.statusText}`);
  }
  const buf = await resp.arrayBuffer();
  return parseNifti(buf);
}

/**
 * Parse an in-memory NIfTI byte buffer.  Exposed separately for tests
 * and for future code paths that fetch the volume some other way.
 */
export function parseNifti(buf: ArrayBuffer): NiftiVolume {
  const reader = niftiReader as unknown as {
    isCompressed(b: ArrayBuffer): boolean;
    decompress(b: ArrayBuffer): ArrayBuffer;
    isNIFTI(b: ArrayBuffer): boolean;
    readHeader(b: ArrayBuffer): NiftiHeaderLike;
    readImage(h: NiftiHeaderLike, b: ArrayBuffer): ArrayBuffer;
  };

  let raw: ArrayBuffer = buf;
  if (reader.isCompressed(raw)) {
    raw = reader.decompress(raw);
  }
  if (!reader.isNIFTI(raw)) {
    throw new Error('Buffer is not a valid NIfTI-1/2 file');
  }

  const header = reader.readHeader(raw);
  const imageBuffer = reader.readImage(header, raw);
  const data = toFloat32(imageBuffer, header.datatypeCode);

  const dims = header.dims as number[];   // [ndim, X, Y, Z, ...]
  const pix = header.pixDims as number[]; // same layout

  const dimensions: [number, number, number] = [dims[1], dims[2], dims[3]];
  const spacing: [number, number, number] = [
    Math.abs(pix[1]) || 1,
    Math.abs(pix[2]) || 1,
    Math.abs(pix[3]) || 1,
  ];

  const affine = computeAffine(header);

  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < dataMin) dataMin = v;
    if (v > dataMax) dataMax = v;
  }
  if (!Number.isFinite(dataMin)) dataMin = 0;
  if (!Number.isFinite(dataMax)) dataMax = 0;

  return { data, dimensions, spacing, affine, dataMin, dataMax };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface NiftiHeaderLike {
  dims: number[];
  pixDims: number[];
  datatypeCode: number;
  // Affine — nifti-reader-js exposes either qform / sform raw matrices.
  affine?: number[][];
  qform_code?: number;
  sform_code?: number;
}

const NIFTI_TYPE = {
  UINT8: 2,
  INT16: 4,
  INT32: 8,
  FLOAT32: 16,
  FLOAT64: 64,
  INT8: 256,
  UINT16: 512,
  UINT32: 768,
} as const;

function toFloat32(buf: ArrayBuffer, datatypeCode: number): Float32Array {
  switch (datatypeCode) {
    case NIFTI_TYPE.FLOAT32:
      return new Float32Array(buf);
    case NIFTI_TYPE.FLOAT64:
      return Float32Array.from(new Float64Array(buf));
    case NIFTI_TYPE.INT16:
      return Float32Array.from(new Int16Array(buf));
    case NIFTI_TYPE.UINT16:
      return Float32Array.from(new Uint16Array(buf));
    case NIFTI_TYPE.INT32:
      return Float32Array.from(new Int32Array(buf));
    case NIFTI_TYPE.UINT32:
      return Float32Array.from(new Uint32Array(buf));
    case NIFTI_TYPE.UINT8:
      return Float32Array.from(new Uint8Array(buf));
    case NIFTI_TYPE.INT8:
      return Float32Array.from(new Int8Array(buf));
    default:
      throw new Error(
        `Unsupported NIfTI datatype code ${datatypeCode}; ` +
        'expected float32 or a small-integer type.',
      );
  }
}

function computeAffine(header: NiftiHeaderLike): Float64Array {
  // nifti-reader-js exposes the affine as `header.affine` for sform > 0.
  // Fall back to identity * spacing if neither qform nor sform is set.
  if (header.affine && header.affine.length === 4) {
    const out = new Float64Array(16);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        out[r * 4 + c] = header.affine[r][c];
      }
    }
    return out;
  }
  const sx = Math.abs(header.pixDims?.[1] ?? 1);
  const sy = Math.abs(header.pixDims?.[2] ?? 1);
  const sz = Math.abs(header.pixDims?.[3] ?? 1);
  // Identity affine scaled by voxel spacing.
  return new Float64Array([
    sx, 0, 0, 0,
    0, sy, 0, 0,
    0, 0, sz, 0,
    0, 0, 0, 1,
  ]);
}
