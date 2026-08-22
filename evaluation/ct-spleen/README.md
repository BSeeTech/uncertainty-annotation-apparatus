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

```bash
# One-time setup for the evaluation scripts (host Python, not the containers)
pip install -r evaluation/ct-spleen/requirements.txt
```

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

## Replicating the reported results (full sequence)

This is the end-to-end procedure from a fresh clone to a regenerated report.
Steps 1–4 are the same as the platform quick-start; only steps 5–8 are specific
to replication. **The whole sequence assumes Docker Desktop is running.**

```bash
# 1. Clone and configure (see the top-level README)
git clone https://github.com/BSeeTech/uncertainty-annotation-apparatus.git
cd uncertainty-annotation-apparatus
cp .env.example .env
# EDIT .env: set POSTGRES_PASSWORD to a strong password

# 2. Provision the MONAI Label checkpoint (official spleen UNet)
python servers/monai-label/scripts/install_checkpoint.py

# 3. Start the stack
docker compose up -d

# 4. Download + verify the MSD dataset (~1.5 GB, live progress, resumable)
python evaluation/ct-spleen/install_dataset.py

# 5. Build the filesystem studies source and let MONAI Label rescan it
mkdir -p evaluation/ct-spleen/data-local/labels/final
copy evaluation\ct-spleen\data\imagesTr\spleen_10.nii.gz evaluation\ct-spleen\data-local\
copy evaluation\ct-spleen\data\imagesTr\spleen_19.nii.gz evaluation\ct-spleen\data-local\
copy evaluation\ct-spleen\data\imagesTr\spleen_29.nii.gz evaluation\ct-spleen\data-local\
copy evaluation\ct-spleen\data\imagesTs\spleen_1.nii.gz evaluation\ct-spleen\data-local\
copy evaluation\ct-spleen\data\imagesTs\spleen_15.nii.gz evaluation\ct-spleen\data-local\
copy evaluation\ct-spleen\data\labelsTr\spleen_10.nii.gz evaluation\ct-spleen\data-local\labels\final\
copy evaluation\ct-spleen\data\labelsTr\spleen_19.nii.gz evaluation\ct-spleen\data-local\labels\final\
copy evaluation\ct-spleen\data\labelsTr\spleen_29.nii.gz evaluation\ct-spleen\data-local\labels\final\
docker compose restart monai-label

# 6. Register the five MSD cases with the uncertainty service (NIfTI cases are
#    NOT in Orthanc, so /cases/sync cannot find them — register each explicitly).
#    Use the study_uid as case_id (the evaluator derives case_id from study_uid).
curl -X POST http://localhost:58050/cases \
  -H "Content-Type: application/json" \
  -d '{"case_id":"1.2.826.0.1.3680043.8.274.1.1.248825330.63900.8824652402.697","patient_id":"patient001","study_uid":"1.2.826.0.1.3680043.8.274.1.1.248825330.63900.8824652402.697","series_uid":"1.2.826.0.1.3680043.8.274.1.1.784017185.94518.4538589876.211","condition":"C2"}'
curl -X POST http://localhost:58050/cases \
  -H "Content-Type: application/json" \
  -d '{"case_id":"1.2.826.0.1.3680043.8.274.1.1.786988705.17387.8717949376.670","patient_id":"patient002","study_uid":"1.2.826.0.1.3680043.8.274.1.1.786988705.17387.8717949376.670","series_uid":"1.2.826.0.1.3680043.8.274.1.1.217746236.48460.8396164103.990","condition":"C2"}'
curl -X POST http://localhost:58050/cases \
  -H "Content-Type: application/json" \
  -d '{"case_id":"1.2.826.0.1.3680043.8.274.1.1.440932339.25736.8771857202.211","patient_id":"patient003","study_uid":"1.2.826.0.1.3680043.8.274.1.1.440932339.25736.8771857202.211","series_uid":"1.2.826.0.1.3680043.8.274.1.1.323164088.69886.2011085890.421","condition":"C2"}'
curl -X POST http://localhost:58050/cases \
  -H "Content-Type: application/json" \
  -d '{"case_id":"1.2.826.0.1.3680043.8.274.1.1.978964378.20833.5934797847.233","patient_id":"patient004","study_uid":"1.2.826.0.1.3680043.8.274.1.1.978964378.20833.5934797847.233","series_uid":"1.2.826.0.1.3680043.8.274.1.1.435486677.64603.2847829754.141","condition":"C2"}'
curl -X POST http://localhost:58050/cases \
  -H "Content-Type: application/json" \
  -d '{"case_id":"1.2.826.0.1.3680043.8.274.1.1.521426503.86857.9032450883.677","patient_id":"patient005","study_uid":"1.2.826.0.1.3680043.8.274.1.1.521426503.86857.9032450883.677","series_uid":"1.2.826.0.1.3680043.8.274.1.1.956292836.56138.4474170934.471","condition":"C2"}'

# 7. Pre-compute the C2 inferences (MC Dropout, T=16). Each case takes several
#    minutes on CPU; run this once and let it finish.
UNCERTAINTY_URL=http://localhost:58050 \
  ./scripts/precompute-all.sh \
  --cases evaluation/ct-spleen/cases.json \
  --output /tmp/reviewer-artifacts

# 8. Generate the report
pip install -r evaluation/ct-spleen/requirements.txt   # one-time
python evaluation/ct-spleen/run_evaluation.py `
  --cases evaluation/ct-spleen/cases.json `
  --references evaluation/ct-spleen/data `
  --service http://localhost:58050 `
  --output evaluation/ct-spleen/results/experimental-results.json
python evaluation/ct-spleen/render_report.py `
  --input evaluation/ct-spleen/results/experimental-results.json `
  --output evaluation/ct-spleen/results/experimental-report.md
```

**Expected result.** The regenerated report should show the same ballpark as the
committed reference report (`evaluation/ct-spleen/results/experimental-report.md`):
Dice ≈ 0.89 / 0.88 / 0.91 for patient001–003 (they have reference masks), and no
Dice for patient004–005 (no reference). Small numeric differences are expected
from nondeterministic MC sampling — differences in the second decimal place are
normal; large deviations (e.g. Dice < 0.8) indicate a setup problem.

> **Notes for testers.**
> - Steps 1–4 are identical to the platform quick-start; if you already ran the
>   stack for the demo, skip straight to step 5.
> - The `cases.json` used by the evaluation is `evaluation/ct-spleen/cases.json`
>   (5 MSD CT cases + 5 DET detection cases). Only the 5 MSD cases are used by
>   the evaluator; the DET rows are for a separate detection workflow.
> - During step 7 you will see expected warnings: C3–C5 inference returns
>   HTTP 400 (only C1/C2 are wired), and the DET cases return HTTP 404 (they are
>   not registered with the uncertainty service). **These are normal** — the C2
>   artifacts for patient001–005 are what the evaluator consumes. The script
>   exits 0 regardless; only "cannot reach uncertainty service" is fatal.
> - The reported results are for **C2 only** (MC Dropout, T=16). Running the
>   evaluator against other conditions is not supported by the current code.

## Getting the dataset

The MSD Task09 Spleen volumes are **not committed** to the repository (they are
large binaries and subject to the MSD data license). Download and verify them
with the included installer:

```bash
# From the repository root:
python evaluation/ct-spleen/install_dataset.py
```

**How long does it take?** The official archive is **~1.5 GB**. On a typical
broadband connection expect **5–30 minutes**; on a slow link it can take much
longer. The installer prints a live progress line (downloaded MB, percent,
speed, ETA), so you can tell it is still working.

**Interrupted? Just re-run the same command.** The installer resumes from the
partial download instead of starting over.

This downloads the official MSD Task09 Spleen archive and verifies it against
`dataset.lock.json` (SHA-256 of the archive and of every extracted file — a
mismatch aborts the install). The installer creates the `data/` layout used by
the evaluation pipeline; the next section shows how to build the `data-local/`
studies layout for MONAI Label.

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
# From the repository root (the folder you cloned into):
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

**After adding or changing files under `data-local/`, restart the container so
the datastore rescans the directory:**

```bash
docker compose restart monai-label
```

> **Note:** NIfTI files cannot be uploaded to Orthanc. Orthanc only accepts DICOM. If you need images
> in Orthanc (e.g. to browse them in the OHIF viewer at `localhost:3000`), convert NIfTI → DICOM
> first using a tool like `plastimatch convert` or `itkimage2segimage`, then upload via the Orthanc
> UI at `http://localhost:8042` and run `curl -X POST http://localhost:58050/cases/sync`.
