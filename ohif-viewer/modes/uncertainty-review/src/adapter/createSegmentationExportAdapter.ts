/**
 * SegmentationExportAdapter implementation.
 *
 * Phase 4's `extension-uncertainty` declares a `SegmentationExportAdapter`
 * interface (see `extension-uncertainty/src/services/UncertaintyService.ts`)
 * and asks the host to implement it.  This file is that implementation.
 *
 * The job: given the current case's reference volume id, return the
 * reviewer's edited segmentation as a NIfTI Blob ready for upload.
 *
 * This adapter targets Cornerstone3D V2 and V3.
 * Segmentation data is read via `segmentation.getSegmentation(segId)`.
 *
 * Missing API paths are logged and yield `null` rather than throwing —
 * the service interprets `null` as "no mask available" and the host UI
 * handles that as a recoverable user-facing error.
 *
 * Producing a valid NIfTI from raw label voxels is non-trivial; the
 * algorithm here writes a minimal NIfTI-1 header inline rather than
 * pulling in `nifti-writer-js`, because nifti-writer-js's package
 * shape changes between versions and the data we need to serialise
 * is small enough to encode by hand with confidence.
 */

import * as cornerstone from '@cornerstonejs/core';
import * as cstoneTools from '@cornerstonejs/tools';

import type { SegmentationExportAdapter } from '@thesis/extension-uncertainty';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface SegmentationExportAdapterOptions {
  /**
   * Returns the active segmentation id for the given reference volume.
   * In OHIF this typically comes from the segmentation service:
   *
   *   servicesManager.services.segmentationService
   *     .getActiveSegmentationByReference(referenceVolumeId)
   *
   * Provided as a thunk so the adapter doesn't have to import OHIF
   * services directly.
   */
  getSegmentationIdForReference: (referenceVolumeId: string) => string | null;
}

export function createSegmentationExportAdapter(
  opts: SegmentationExportAdapterOptions,
): SegmentationExportAdapter {
  return {
    async exportSegmentationAsNiftiBlob(args) {
      const segId = opts.getSegmentationIdForReference(args.referenceVolumeId);
      if (!segId) {
        // eslint-disable-next-line no-console
        console.warn(
          '[SegmentationExportAdapter] No segmentation id for reference volume ' +
          args.referenceVolumeId,
        );
        // No manual segmentation drawn (C0 without annotation, or no AI mask).
        // Return an empty (all-zero) mask so the reviewer can submit with
        // 0 voxels edited rather than getting a hard error.
        return emptyMaskFromReference(args.referenceVolumeId);
      }

      const labelmap = await readLabelmapVolume(segId);
      if (!labelmap) {
        console.warn(
          '[SegmentationExportAdapter] Segmentation found but labelmap volume missing ' +
          'for segId=' + segId + '; falling back to empty mask.',
        );
        return emptyMaskFromReference(args.referenceVolumeId);
      }

      return blobFromLabelmap(labelmap);
    },
  };
}

// ---------------------------------------------------------------------------
// Internals - Cornerstone3D V3 labelmap access
// ---------------------------------------------------------------------------

interface LabelmapVolume {
  data: Uint8Array | Uint16Array | Int16Array;
  dimensions: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  /** Row-major 3x3 direction cosines, flattened. */
  direction: number[];
}

/**
 * Create an empty (all-zero) labelmap volume from a reference volume's
 * geometry.  Used on C0 when the reviewer has not drawn any annotation:
 * the submission still goes through with 0 voxels edited.
 *
 * Returns `null` if the reference volume is not in the cache, which
 * makes the caller fall back to a hard error (same as before the
 * empty-mask path was added).
 */
function emptyMaskFromReference(referenceVolumeId: string): Blob | null {
  const cache: Any = (cornerstone as Any).cache;
  const refVol: Any = cache?.getVolume?.(referenceVolumeId);
  if (!refVol) return null;

  const dims: [number, number, number] = refVol.dimensions;
  const total = dims[0] * dims[1] * dims[2];
  const data = new Uint8Array(total);  // all zeros

  return blobFromLabelmap({
    data,
    dimensions: dims,
    spacing: refVol.spacing,
    origin: refVol.origin,
    direction: refVol.direction ?? IDENTITY_DIRECTION,
  });
}

async function readLabelmapVolume(segmentationId: string): Promise<LabelmapVolume | null> {
  const tools: Any = cstoneTools as Any;
  const cache: Any = (cornerstone as Any).cache;

  // -------------------------------------------------------------
  // Cornerstone3D V3: segmentation.state.getSegmentation(segId)
  // V2 fallback: segmentation.getSegmentation(segId)
  // -------------------------------------------------------------

  const seg: Any = tools?.segmentation?.state?.getSegmentation?.(segmentationId)
    ?? tools?.segmentation?.getSegmentation?.(segmentationId);
  if (!seg) return null;

  const repr = seg?.representationData?.LABELMAP
    ?? seg?.representationData?.Labelmap
    ?? seg?.representationData;
  if (!repr) return null;

  const volumeId: string | undefined = repr.volumeId ?? repr.cachedSegmentationDataInVolumeRef;
  if (!volumeId) return null;

  const volume = cache?.getVolume?.(volumeId);
  if (!volume) {
    // eslint-disable-next-line no-console
    console.warn(`[SegmentationExportAdapter] Segmentation volume ${volumeId} not in cache`);
    return null;
  }

  let rawData: unknown = volume.scalarData
    ?? (typeof volume.getScalarData === 'function' ? volume.getScalarData() : undefined)
    ?? volume.voxelManager?.getCompleteScalarDataArray?.()
    ?? volume.imageData?.getPointData?.()?.getScalars?.()?.getData?.();

  // Cornerstone may expose scalarData as an array of typed arrays for
  // multi-component volumes.  For a binary labelmap the array has exactly
  // one element; unpack it so the NIfTI writer below receives a single
  // typed array.
  if (Array.isArray(rawData)) {
    rawData = rawData[0];
  }

  const data = rawData as Uint8Array | Uint16Array | Int16Array | undefined;
  if (!data) return null;

  return {
    data,
    dimensions: volume.dimensions,
    spacing: volume.spacing,
    origin: volume.origin,
    direction: volume.direction ?? IDENTITY_DIRECTION,
  };
}

const IDENTITY_DIRECTION: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// ---------------------------------------------------------------------------
// Internals — minimal NIfTI-1 writer
//
// We write an uncompressed NIfTI-1 here.  The FastAPI side accepts
// both .nii and .nii.gz; the gzip step is omitted to keep the
// dependency surface zero — typical 256x256x150 uint8 masks come out
// at ~10 MB which is fine for an opt-in submission.  The mask
// filename is `<caseId>.nii` and the server stores it as `.nii.gz`
// after re-encoding (nibabel transparently handles either).
// ---------------------------------------------------------------------------

const NIFTI_HEADER_SIZE = 348;
const NIFTI_DATATYPE = {
  UINT8: 2,
  INT16: 4,
  UINT16: 512,
} as const;
const NIFTI_BITPIX = {
  UINT8: 8,
  INT16: 16,
  UINT16: 16,
} as const;

function blobFromLabelmap(vol: LabelmapVolume): Blob {
  // ---- Pick datatype from the array ---------------------------
  let datatype: number;
  let bitpix: number;
  if (vol.data instanceof Uint8Array) {
    datatype = NIFTI_DATATYPE.UINT8; bitpix = NIFTI_BITPIX.UINT8;
  } else if (vol.data instanceof Int16Array) {
    datatype = NIFTI_DATATYPE.INT16; bitpix = NIFTI_BITPIX.INT16;
  } else if (vol.data instanceof Uint16Array) {
    datatype = NIFTI_DATATYPE.UINT16; bitpix = NIFTI_BITPIX.UINT16;
  } else {
    throw new Error(
      `[SegmentationExportAdapter] Unsupported labelmap data type ` +
      `(${(vol.data as Any)?.constructor?.name})`,
    );
  }

  // ---- Header ------------------------------------------------
  const header = new ArrayBuffer(NIFTI_HEADER_SIZE);
  const dv = new DataView(header);
  const u8 = new Uint8Array(header);

  dv.setInt32(0, NIFTI_HEADER_SIZE, true);          // sizeof_hdr

  // dim[0]=3, dim[1..3]=X,Y,Z, dim[4..7]=1,1,1,1
  dv.setInt16(40, 3, true);
  dv.setInt16(42, vol.dimensions[0], true);
  dv.setInt16(44, vol.dimensions[1], true);
  dv.setInt16(46, vol.dimensions[2], true);
  dv.setInt16(48, 1, true);
  dv.setInt16(50, 1, true);
  dv.setInt16(52, 1, true);
  dv.setInt16(54, 1, true);

  dv.setInt16(70, datatype, true);                  // datatype
  dv.setInt16(72, bitpix, true);                    // bitpix

  // pixdim[0..7] — pixdim[0] is qfac (we use 1).  pixdim[1..3] = spacing.
  dv.setFloat32(76, 1, true);
  dv.setFloat32(80, vol.spacing[0], true);
  dv.setFloat32(84, vol.spacing[1], true);
  dv.setFloat32(88, vol.spacing[2], true);

  dv.setFloat32(108, NIFTI_HEADER_SIZE, true);      // vox_offset
  dv.setFloat32(112, 1, true);                      // scl_slope
  dv.setFloat32(116, 0, true);                      // scl_inter

  // qform_code = 0 (use sform), sform_code = 1 (scanner anatomical).
  dv.setInt16(252, 0, true);
  dv.setInt16(254, 1, true);

  // sform: [direction * spacing  origin] flattened.  Direction is row-major
  // 3x3; we lay it out as the 4x3 matrix [Rx Ry Rz Tx; Sx Sy Sz Ty; ...].
  const sform = new Float32Array([
    vol.direction[0] * vol.spacing[0],
    vol.direction[3] * vol.spacing[1],
    vol.direction[6] * vol.spacing[2],
    vol.origin[0],
    vol.direction[1] * vol.spacing[0],
    vol.direction[4] * vol.spacing[1],
    vol.direction[7] * vol.spacing[2],
    vol.origin[1],
    vol.direction[2] * vol.spacing[0],
    vol.direction[5] * vol.spacing[1],
    vol.direction[8] * vol.spacing[2],
    vol.origin[2],
  ]);
  let off = 280;
  for (let i = 0; i < sform.length; i++) {
    dv.setFloat32(off + i * 4, sform[i], true);
  }

  // magic = "n+1\0" at offset 344.  This is the in-file magic that
  // marks a NIfTI-1 single-file image.
  u8[344] = 0x6e;        // 'n'
  u8[345] = 0x2b;        // '+'
  u8[346] = 0x31;        // '1'
  u8[347] = 0x00;        // '\0'

  // ---- Pack data -------------------------------------------
  // The voxel buffer follows the header directly because vox_offset = 348.
  // Cornerstone may store scalar buffers in SharedArrayBuffer-backed typed
  // arrays. Chromium rejects SharedArrayBuffer views as Blob parts, so copy
  // into a normal ArrayBuffer-backed Uint8Array before upload serialization.
  const dataBytes = new Uint8Array(vol.data.byteLength);
  dataBytes.set(new Uint8Array(
    vol.data.buffer,
    vol.data.byteOffset,
    vol.data.byteLength,
  ));

  return new Blob(
    [header, dataBytes as unknown as BlobPart],
    { type: 'application/octet-stream' },
  );
}
