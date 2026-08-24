"""Annotation diff service: voxel-wise comparison of reviewer vs AI masks.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class AnnotationDiff:
    """Result of comparing a reviewer mask against an AI prediction."""

    edit_voxel_count: int
    ai_foreground_voxels: int
    reviewer_foreground_voxels: int
    edit_fraction_of_ai_foreground: float


def diff_arrays(
    reviewer: np.ndarray,
    ai: np.ndarray,
) -> AnnotationDiff:
    """Compare two masks voxel-wise and return edit statistics.

    Both arrays must have the same shape. A leading singleton channel
    dimension (shape[0] == 1) is stripped automatically.
    """
    if reviewer.shape != ai.shape:
        raise ValueError(
            f"Shape mismatch: reviewer {reviewer.shape} != ai {ai.shape}"
        )

    # Strip leading singleton channel
    r = reviewer.copy()
    a = ai.copy()
    if r.ndim > 2 and r.shape[0] == 1:
        r = r[0]
    if a.ndim > 2 and a.shape[0] == 1:
        a = a[0]

    r_bin = (r > 0).astype(np.int16)
    a_bin = (a > 0).astype(np.int16)

    edit_voxels = int(np.sum(r_bin != a_bin))
    ai_fg = int(np.sum(a_bin))
    reviewer_fg = int(np.sum(r_bin))

    if ai_fg > 0:
        edit_frac = edit_voxels / ai_fg
    else:
        edit_frac = 0.0

    return AnnotationDiff(
        edit_voxel_count=edit_voxels,
        ai_foreground_voxels=ai_fg,
        reviewer_foreground_voxels=reviewer_fg,
        edit_fraction_of_ai_foreground=edit_frac,
    )


def load_nifti(path: str | Path) -> np.ndarray:
    """Load the scalar array from a NIfTI-1 file used by the apparatus."""
    import gzip
    import struct
    from array import array

    def _load(path: Path) -> np.ndarray:
        raw = Path(path).read_bytes()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        endian = "<"
        sizeof_hdr = struct.unpack_from("<i", raw, 0)[0]
        if sizeof_hdr != 348:
            sizeof_hdr = struct.unpack_from(">i", raw, 0)[0]
            endian = ">"
        if sizeof_hdr != 348:
            raise ValueError(f"{path} is not a NIfTI-1 file")
        dims = struct.unpack_from(f"{endian}8h", raw, 40)
        ndim = max(1, int(dims[0]))
        shape = tuple(max(1, int(dims[i])) for i in range(1, ndim + 1))
        datatype = struct.unpack_from(f"{endian}h", raw, 70)[0]
        vox_offset = int(struct.unpack_from(f"{endian}f", raw, 108)[0])
        type_map = {2: ("B", 1), 4: ("h", 2), 16: ("f", 4), 512: ("H", 2)}
        typecode, bpv = type_map.get(datatype, ("f", 4))
        n_voxels = int(np.prod(shape))
        body = raw[vox_offset: vox_offset + n_voxels * bpv]
        vals = array(typecode)
        vals.frombytes(body)
        if endian == ">":
            vals.byteswap()
        return np.array(vals, dtype=np.float64).reshape(shape)

    return _load(Path(path))


def diff_files(
    reviewer_path: str | Path,
    ai_path: str | Path,
) -> AnnotationDiff:
    """Load two NIfTI volumes from disk and compute their diff."""
    reviewer_arr = load_nifti(reviewer_path)
    ai_arr = load_nifti(ai_path)
    return diff_arrays(reviewer_arr, ai_arr)
