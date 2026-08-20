"""Generate a synthetic CT-like NIfTI for smoke testing.

Drops a small NIfTI volume into the MONAI Label studies directory so that
``smoke_test.sh`` has at least one image to infer on without requiring a
real DICOM series.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
import nibabel as nib


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out-dir", default="./data/dicom",
        help="MONAI Label studies dir (where the synthetic file will be written)",
    )
    parser.add_argument("--name", default="synthetic_case_001.nii.gz")
    parser.add_argument("--shape", nargs=3, type=int, default=(96, 96, 64))
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / args.name

    rng = np.random.default_rng(args.seed)
    vol = rng.normal(loc=40.0, scale=20.0, size=args.shape).astype(np.float32)

    cz, cy, cx = (s // 2 for s in args.shape)
    rz = ry = rx = 12
    zz, yy, xx = np.ogrid[:args.shape[0], :args.shape[1], :args.shape[2]]
    blob = ((zz - cz) / rz) ** 2 + ((yy - cy) / ry) ** 2 + ((xx - cx) / rx) ** 2 < 1.0
    vol[blob] += 120.0

    affine = np.diag([1.5, 1.5, 2.0, 1.0]).astype(np.float32)
    nib.save(nib.Nifti1Image(vol, affine), str(out_path))
    print(f"wrote {out_path}  shape={args.shape}  size={os.path.getsize(out_path)} B")


if __name__ == "__main__":
    main()
