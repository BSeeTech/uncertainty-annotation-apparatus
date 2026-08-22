"""Convert the 5 MSD NIfTI volumes to DICOM and upload to Orthanc.

The uncertainty-service replication pipeline requires each evaluation case to
exist in Orthanc under the EXACT study/series UIDs recorded in
``evaluation/ct-spleen/cases.json`` (``precompute_cases.py`` validates the
series via QIDO before running MONAI inference). The MSD dataset ships as
NIfTI, so it must be converted first.

Steps per case:
  1. ``plastimatch convert`` NIfTI -> DICOM series (PatientID set to the
     case's patient_id; plastimatch generates its own UIDs).
  2. Rewrite StudyInstanceUID / SeriesInstanceUID with pydicom to the fixed
     values from cases.json.
  3. Upload every .dcm of the series to Orthanc (POST /instances).

Requirements (host): plastimatch on PATH, Python with pydicom + requests,
a running Orthanc (default http://localhost:8042), and the MSD dataset
installed (``python evaluation/ct-spleen/install_dataset.py``).

Usage:
    python scripts/prepare-msd-for-orthanc.py \
        --cases evaluation/ct-spleen/cases.json \
        --data evaluation/ct-spleen/data \
        [--orthanc http://localhost:8042] \
        [--patient-id patient001 ...]
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pydicom
import requests

MSD_TO_SPLIT = {
    "spleen_10": "imagesTr",
    "spleen_19": "imagesTr",
    "spleen_29": "imagesTr",
    "spleen_1": "imagesTs",
    "spleen_15": "imagesTs",
}


def find_plastimatch() -> str:
    exe = shutil.which("plastimatch")
    if exe:
        return exe
    candidates = [
        r"C:\Program Files\Plastimatch\bin\plastimatch.exe",
        r"C:\Program Files\Plastimatch\bin\plastimatch",
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    raise SystemExit(
        "plastimatch not found on PATH. Install it (e.g. `winget install "
        "Plastimatch` or https://plastimatch.org) or pass --plastimatch."
    )


def convert_and_rewrite(
    plastimatch: str,
    nifti: Path,
    out_dir: Path,
    study_uid: str,
    series_uid: str,
    patient_id: str,
) -> None:
    subprocess.run(
        [
            plastimatch,
            "convert",
            "--input",
            str(nifti),
            "--output-dicom",
            str(out_dir),
            "--patient-id",
            patient_id,
        ],
        check=True,
        capture_output=True,
    )
    dcm_files = sorted(glob.glob(str(out_dir / "*.dcm")))
    if not dcm_files:
        raise SystemExit(f"plastimatch produced no DICOM for {nifti}")
    for path in dcm_files:
        ds = pydicom.dcmread(path)
        ds.StudyInstanceUID = study_uid
        ds.SeriesInstanceUID = series_uid
        ds.PatientID = patient_id
        ds.save_as(path)


def upload_series(orthanc: str, out_dir: Path) -> int:
    uploaded = 0
    for path in sorted(glob.glob(str(out_dir / "*.dcm"))):
        with open(path, "rb") as handle:
            resp = requests.post(
                f"{orthanc}/instances",
                data=handle,
                timeout=60,
            )
        if resp.status_code not in (200, 201, 409):
            raise SystemExit(
                f"Orthanc upload failed for {Path(path).name}: "
                f"HTTP {resp.status_code} {resp.text[:200]}"
            )
        uploaded += 1
    return uploaded


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True, type=Path)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--orthanc", default="http://localhost:8042")
    parser.add_argument(
        "--patient-id",
        action="append",
        help="Process only the selected patient id; may be repeated.",
    )
    parser.add_argument("--plastimatch", default=None)
    parser.add_argument("--work-dir", default=None, type=Path)
    args = parser.parse_args()

    plastimatch = args.plastimatch or find_plastimatch()
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    msd_cases = [c for c in cases if c.get("msd_case")]
    if args.patient_id:
        selected = set(args.patient_id)
        msd_cases = [c for c in msd_cases if c.get("patient_id") in selected]
        missing = selected - {c.get("patient_id") for c in msd_cases}
        if missing:
            raise SystemExit(f"unknown patient ids: {sorted(missing)}")

    temp_root = args.work_dir or Path(tempfile.mkdtemp(prefix="msd-dicom-"))
    total = 0
    try:
        for case in msd_cases:
            msd_case = case["msd_case"]
            split = MSD_TO_SPLIT[msd_case]
            nifti = args.data / split / f"{msd_case}.nii.gz"
            if not nifti.exists():
                raise SystemExit(f"missing NIfTI: {nifti} (run install_dataset.py)")
            patient_id = case["patient_id"]
            out_dir = temp_root / patient_id
            out_dir.mkdir(parents=True, exist_ok=True)
            print(f"[{patient_id}] converting {nifti.name} ...")
            convert_and_rewrite(
                plastimatch,
                nifti,
                out_dir,
                study_uid=case["study_uid"],
                series_uid=case["series_uid"],
                patient_id=patient_id,
            )
            print(f"[{patient_id}] uploading {len(glob.glob(str(out_dir / '*.dcm')))} files ...")
            uploaded = upload_series(args.orthanc, out_dir)
            total += uploaded
            print(f"[{patient_id}] done ({uploaded} instances)")
    finally:
        if args.work_dir is None:
            shutil.rmtree(temp_root, ignore_errors=True)

    print(f"\nUploaded {total} DICOM instances to {args.orthanc}")
    print("Next: curl -X POST http://localhost:58050/cases/sync")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
