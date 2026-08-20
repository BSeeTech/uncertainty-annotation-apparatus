# CT spleen checkpoint evaluation

This package evaluates the official MONAI Label CT spleen checkpoint with
`T=16`. The fixed mapping is recorded in `cases.json`.

- patient001–patient003 have official MSD reference masks and contribute to
  segmentation-quality, calibration, and uncertainty-error metrics.
- patient004–patient005 have no official reference masks and contribute only
  to runtime, operational uncertainty, artifact-integrity, and workflow
  evaluation.
- Synthetic smoke tests use the separate
  `synthetic_plumbing_validation` provenance category and are never included
  in checkpoint experiment aggregates.

After C2 has been precomputed for all five cases, run the evaluator in an
environment containing NumPy, SciPy, and nibabel:

```powershell
python evaluation/ct-spleen/run_evaluation.py `
  --cases evaluation/ct-spleen/cases.json `
  --references evaluation/ct-spleen/data `
  --service http://localhost:58050 `
  --output evaluation/ct-spleen/results/experimental-results.json

python evaluation/ct-spleen/render_report.py `
  --input evaluation/ct-spleen/results/experimental-results.json `
  --output evaluation/ct-spleen/results/experimental-report.md
```

## Getting the dataset

The MSD Task09 Spleen volumes are **not committed** to the repository (they are
large binaries and subject to the MSD data license). Download and verify them
with the included installer:

```bash
# From the repository root:
python evaluation/ct-spleen/install_dataset.py
```

This downloads the official MSD Task09 Spleen archive and verifies it against
`dataset.lock.json` (SHA-256 of the archive and of every extracted file). The
installer creates the `data/` layout used by the evaluation pipeline and
prints the exact commands for building the `data-local/` studies layout below.

> **License note:** the dataset is the Medical Segmentation Decathlon
> Task09 Spleen ("MSD Task09 Spleen"). Downloading and using it requires
> agreeing to the MSD data usage terms at the download source. The
> repository stores only checksums and provenance, not the volumes.

## Data sources

Two data directories are produced from `install_dataset.py`:

| Directory | Purpose | Content |
|-----------|---------|---------|
| `evaluation/ct-spleen/data/` | **Evaluation reference** — read by `run_evaluation.py` (`--references`) to compare predicted masks against ground truth | Original MSD layout: `imagesTr/`, `imagesTs/`, `labelsTr/` |
| `evaluation/ct-spleen/data-local/` | **MONAI Label studies source** — mounted into the `monai-label` container as `/workspace/data/studies` | Flat layout for `LocalDatastore`: `.nii.gz` images at root, labels under `labels/final/` |

### Preparing the filesystem studies source

After running `install_dataset.py`, create the flattened studies directory for MONAI Label:

```powershell
cd C:\medical-imaging-platform
mkdir -p evaluation/ct-spleen/data-local/labels/final

# Copy training images (patient001-003)
copy evaluation\ct-spleen\data\imagesTr\spleen_10.nii.gz evaluation\ct-spleen\data-local\
copy evaluation\ct-spleen\data\imagesTr\spleen_19.nii.gz evaluation\ct-spleen\data-local\
copy evaluation\ct-spleen\data\imagesTr\spleen_29.nii.gz evaluation\ct-spleen\data-local\

# Copy test images (patient004-005)
copy evaluation\ct-spleen\data\imagesTs\spleen_1.nii.gz evaluation\ct-spleen\data-local\
copy evaluation\ct-spleen\data\imagesTs\spleen_15.nii.gz evaluation\ct-spleen\data-local\

# Copy ground-truth labels (only patient001-003 have them)
copy evaluation\ct-spleen\data\labelsTr\spleen_10.nii.gz evaluation\ct-spleen\data-local\labels\final\
copy evaluation\ct-spleen\data\labelsTr\spleen_19.nii.gz evaluation\ct-spleen\data-local\labels\final\
copy evaluation\ct-spleen\data\labelsTr\spleen_29.nii.gz evaluation\ct-spleen\data-local\labels\final\
```

This produces the flat layout that MONAI Label's `LocalDatastore` expects:

```
evaluation/ct-spleen/data-local/
├── spleen_10.nii.gz
├── spleen_19.nii.gz
├── spleen_29.nii.gz
├── spleen_1.nii.gz
├── spleen_15.nii.gz
└── labels/
    └── final/
        ├── spleen_10.nii.gz
        ├── spleen_19.nii.gz
        └── spleen_29.nii.gz
```

### Running with filesystem studies (no Orthanc needed)

The `docker-compose.yml` binds `./evaluation/ct-spleen/data-local` to `/workspace/data/studies` in the
`monai-label` container and passes `--studies /workspace/data/studies` instead of the DICOMweb URL.
MONAI Label auto-discovers the `.nii.gz` files via `LocalDatastore` — no DICOM conversion or Orthanc
dependency required.

> **Note:** NIfTI files cannot be uploaded to Orthanc. Orthanc only accepts DICOM. If you need images
> in Orthanc, convert NIfTI → DICOM first using a tool like `plastimatch convert` or `itkimage2segimage`.
