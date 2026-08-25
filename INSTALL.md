# Install and reproduce the thesis evaluation

This is the single installation runbook for the **Uncertainty Annotation Apparatus (UAA)**. It takes a clean Windows computer from no repository to a running reviewer, five restored Medical Segmentation Decathlon (MSD) spleen studies, precomputed uncertainty results, and reproducible evaluation reports.

The commands are for **Windows PowerShell**. Run each code block as a block. They use PowerShell syntax and work in Windows PowerShell 5.1, where `&&` is not a command separator.

> Evaluation use only: the shared local PostgreSQL password is `uaa-evaluation-only`. It is intentionally not a production secret. Do not expose this stack to the public internet or use it for clinical data.

## What this installs and restores

- Git, Python 3.12, Node.js LTS, Yarn Classic, Docker Desktop, and Plastimatch
- the UAA repository and its Docker images
- Orthanc, MONAI Label, PostgreSQL, the uncertainty and collaboration services
- the verified MONAI spleen model checkpoint
- MSD Task09 Spleen (about 1.5 GB), with five thesis-validation studies converted to DICOM and uploaded to Orthanc
- C2 Monte Carlo dropout inference for those five studies
- the OHIF reviewer and evaluation/reporting environment

Allow about 30 GB of free disk space. A machine with 16 GB RAM is recommended. CPU inference normally takes about 20 minutes after the images have been restored.

## 1. Install the toolchains (once per computer)

Open **PowerShell as Administrator**:

```powershell
wsl --install

winget install --id Git.Git --exact --accept-package-agreements --accept-source-agreements
winget install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements
winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
winget install --id Docker.DockerDesktop --exact --accept-package-agreements --accept-source-agreements
```

Restart Windows if requested. Start Docker Desktop and wait until its engine is running.

Install the current Windows MSI from the official [Plastimatch Windows installation page](https://plastimatch.org/windows_installation.html), accepting its default location. It performs the required NIfTI-to-DICOM conversion.

Open a **new, ordinary PowerShell window**, then install Yarn Classic and verify the tools:

```powershell
npm install --global yarn@1.22.22

git --version
python --version
node --version
yarn --version
docker --version
docker compose version
plastimatch --version
```

If `plastimatch` is not on `PATH`, that is acceptable when installed at `C:\Program Files\Plastimatch\bin\plastimatch.exe`, which the loader also checks.

## 2. Download and configure UAA

```powershell
Set-Location C:\
git clone https://github.com/BSeeTech/uncertainty-annotation-apparatus.git
Set-Location C:\uncertainty-annotation-apparatus

Copy-Item .env.example .env -Force

python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r evaluation/ct-spleen/requirements.txt
python -m pip install -r servers/uncertainty-service/requirements-test.txt
```

If activation is blocked, run the following, reopen PowerShell, and activate again:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

The example environment already contains all evaluation settings and the shared PostgreSQL password. No `.env` editing is required.

## 3. Download/build the containers and start the services

Keep `.venv` active and remain in the repository root:

```powershell
python servers/monai-label/scripts/install_checkpoint.py

docker compose build --pull
docker compose up -d
docker compose ps
```

The first build downloads several large images. Continue when every listed service is running or healthy. To inspect startup from another window:

```powershell
Set-Location C:\uncertainty-annotation-apparatus
docker compose logs --follow
```

`Ctrl+C` stops log watching; the containers keep running.

## 4. Download and restore the thesis imaging data

From the repository root, with `.venv` active, run the single resumable loader:

```powershell
Set-Location C:\uncertainty-annotation-apparatus
.\.venv\Scripts\Activate.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\setup-demo-data.ps1
```

It verifies the model and dataset, downloads MSD Task09 Spleen, restores the five mapped studies, uploads their DICOM instances to Orthanc, registers the cases, and computes C2 uncertainty. Three studies have official reference masks for Dice validation; two test studies have no public reference masks and are retained for workflow review.

Do not close this window during inference. Inspect progress from another window with:

```powershell
docker logs medical-monai --follow
```

## 5. Install and start the OHIF reviewer

Open a **second PowerShell window**:

```powershell
Set-Location C:\uncertainty-annotation-apparatus\ohif-viewer
Set-Location platform\app
Copy-Item .env.example .env -Force
Set-Location ..\..

yarn install
yarn dev
```

Keep this window open. A successful start prints the local viewer URL. The first install can take several minutes.

## 6. Validate the installation

Open a third PowerShell window and run these read-only checks:

```powershell
Invoke-RestMethod http://localhost:8043/uncertainty/health
Invoke-RestMethod http://localhost:8043/uncertainty/health/ready
Invoke-RestMethod http://localhost:8042/system
Invoke-RestMethod http://localhost:8000/info
Invoke-RestMethod http://localhost:3001/health
Invoke-RestMethod http://localhost:8043/uncertainty/cases
```

Open the three study conditions:

- C0: <http://localhost:3000/uncertainty-review?reviewer=R01&condition=C0>
- C1: <http://localhost:3000/uncertainty-review?reviewer=R01&condition=C1>
- C2: <http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2>
- Orthanc: <http://localhost:8042>

Use synthetic reviewer identifiers `R01` through `R12`. C0 is review without AI, C1 is AI segmentation without uncertainty, and C2 adds uncertainty visualization.

## 7. Reproduce the technical evaluation report

```powershell
Set-Location C:\uncertainty-annotation-apparatus
.\.venv\Scripts\Activate.ps1

python evaluation/ct-spleen/run_evaluation.py `
  --cases evaluation/ct-spleen/cases.json `
  --references evaluation/ct-spleen/data `
  --service http://localhost:8043/uncertainty `
  --output evaluation/ct-spleen/results/experimental-results.json

python evaluation/ct-spleen/render_report.py `
  --input evaluation/ct-spleen/results/experimental-results.json `
  --output evaluation/ct-spleen/results/experimental-report.md
```

Review `evaluation/ct-spleen/results/experimental-results.json` and `evaluation/ct-spleen/results/experimental-report.md`. Expected Dice scores for the three labeled cases are approximately 0.89, 0.88, and 0.91; small Monte Carlo differences can occur.

## 8. Regenerate the synthetic reviewer-study fixture (optional)

The thesis repository separates reproducible **synthetic fixtures** from real participant data. This deterministic generator creates a reviewable SQL fixture containing 12 synthetic participants, 36 sessions, 108 attempts, NASA-TLX rows, and segmentation-metric rows. It does not recreate or claim human observations.

```powershell
Set-Location C:\uncertainty-annotation-apparatus
.\.venv\Scripts\Activate.ps1
python scripts/generate-research-data.py --seed 42
```

Review the generated `evaluation/ct-spleen/research-data.sql`. Its immutable research schema is an export/validation artifact and is intentionally separate from the apparatus's operational PostgreSQL schema, so do not import it into the running application database. Treat statistics derived from it as simulated pipeline-validation results, not evidence from human participants.

## Daily start and stop

Start after the first installation:

```powershell
Set-Location C:\uncertainty-annotation-apparatus
docker compose up -d

Set-Location ohif-viewer
yarn dev
```

Stop without deleting data:

```powershell
Set-Location C:\uncertainty-annotation-apparatus
docker compose stop
```

## Troubleshooting

### PowerShell rejects `&&`

Use the commands in this guide on separate lines. Do not paste Bash commands containing `&&` into Windows PowerShell 5.1.

### OHIF says `Failed to load ./.env`

```powershell
Set-Location C:\uncertainty-annotation-apparatus\ohif-viewer\platform\app
Copy-Item .env.example .env -Force
Set-Location ..\..
yarn dev
```

### PostgreSQL authentication fails after updating an older checkout

An existing Docker volume retains its original password. Preserve its data and update the role:

```powershell
docker exec medical-postgres psql -U medical_imaging -d annotations `
  -c "ALTER USER medical_imaging WITH PASSWORD 'uaa-evaluation-only';"
docker compose restart uncertainty-service collaboration-server
```

### A service is unhealthy

```powershell
docker compose ps
docker compose logs --tail 200 uncertainty-service
docker compose logs --tail 200 monai-label
docker compose logs --tail 200 postgres
```

### Restart from an empty evaluation database

This deliberately deletes UAA Docker database and generated-service volumes; the downloaded source dataset in the repository remains:

```powershell
Set-Location C:\uncertainty-annotation-apparatus
docker compose down -v
docker compose up -d
powershell -ExecutionPolicy Bypass -File .\scripts\setup-demo-data.ps1
```

## Update or uninstall

Update while preserving volumes:

```powershell
Set-Location C:\uncertainty-annotation-apparatus
git pull
docker compose build --pull
docker compose up -d
```

Stop and remove only UAA containers and networks with `docker compose down`. To also remove Docker volumes, use `docker compose down -v`. Delete `C:\uncertainty-annotation-apparatus` manually only if you also want to remove the repository and downloaded MSD files.

After installation, execute [THESIS-CAPABILITY-VALIDATION.md](THESIS-CAPABILITY-VALIDATION.md) to test the complete implemented thesis capability set with explicit evidence and pass/fail criteria.
