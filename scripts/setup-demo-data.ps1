# ============================================================
# setup-demo-data.ps1
#
# One-command demo data loader for the Uncertainty Annotation
# Apparatus (UAA). Runs the whole data-preparation sequence so a
# non-technical tester only needs to run THIS script:
#
#   1. Downloads + verifies the MSD Task09 Spleen dataset (~1.5 GB,
#      with live progress; re-running resumes instead of restarting)
#   2. Converts the 5 MSD NIfTI volumes to DICOM with the exact UIDs
#      from cases.json and uploads them to Orthanc
#   3. Registers the 5 cases with the uncertainty service
#   4. Generates the C2 inferences (MC Dropout, T=16) — several
#      minutes per case on CPU
#
# Requirements:
#   - Docker Desktop running with the stack up:
#       docker compose up -d
#   - Python with pydicom + requests (installed automatically below)
#   - plastimatch (https://plastimatch.org) on PATH or at the default
#     install location
#
# Usage (from the repository root):
#   powershell -ExecutionPolicy Bypass -File scripts/setup-demo-data.ps1
#
# Re-running is safe: completed steps are skipped.
# ============================================================

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "──────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "▶ $Message" -ForegroundColor Cyan
    Write-Host "──────────────────────────────────────────────────" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  ✅ $Message" -ForegroundColor Green
}

$RepoRoot = (Get-Location).Path

Write-Host "`n╔═══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   🏥 UAA — Demo Data Setup                        ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════════╝`n" -ForegroundColor Cyan

# ------------------------------------------------------------
# 0. Preflight: stack running?
# ------------------------------------------------------------
Write-Step "Checking that the Docker stack is running"
$services = docker compose ps --format "{{.Name}} {{.Status}}" 2>$null
if ($LASTEXITCODE -ne 0 -or -not $services) {
    Write-Host "  ❌ Docker stack is not running." -ForegroundColor Red
    Write-Host "     Start Docker Desktop, wait for 'Engine running', then run:"
    Write-Host "       docker compose up -d"
    exit 1
}
Write-Ok "Stack is running"

Write-Step "Checking the NIfTI-to-DICOM converter"
$PlastimatchCommand = Get-Command plastimatch -ErrorAction SilentlyContinue
$PlastimatchDefault = "C:\Program Files\Plastimatch\bin\plastimatch.exe"
if (-not $PlastimatchCommand -and -not (Test-Path -LiteralPath $PlastimatchDefault)) {
    Write-Host "  X Plastimatch was not found." -ForegroundColor Red
    Write-Host "    Install the Windows MSI from https://plastimatch.org/windows_installation.html"
    Write-Host "    Then open a new PowerShell window and run this script again."
    exit 1
}
Write-Ok "Plastimatch is available"

# ------------------------------------------------------------
# 1. MONAI Label checkpoint
# ------------------------------------------------------------
Write-Step "Ensuring the MONAI Label checkpoint is installed"
python servers/monai-label/scripts/install_checkpoint.py | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ❌ Checkpoint install failed." -ForegroundColor Red
    exit 1
}
Write-Ok "Checkpoint ready"

# ------------------------------------------------------------
# 2. MSD dataset download (resumable, ~1.5 GB)
# ------------------------------------------------------------
Write-Step "Downloading the MSD Task09 Spleen dataset (~1.5 GB)"
Write-Host "     This can take 30+ minutes on a slow connection."
Write-Host "     The installer shows live progress; re-running resumes."
python evaluation/ct-spleen/install_dataset.py
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ❌ Dataset install failed." -ForegroundColor Red
    exit 1
}
Write-Ok "Dataset downloaded and verified"

# ------------------------------------------------------------
# 3. Filesystem studies source for MONAI Label
# ------------------------------------------------------------
Write-Step "Preparing the MONAI Label studies folder"
New-Item -ItemType Directory -Force -Path evaluation/ct-spleen/data-local/labels/final | Out-Null
Copy-Item evaluation/ct-spleen/data/imagesTr/spleen_10.nii.gz evaluation/ct-spleen/data-local/ -Force
Copy-Item evaluation/ct-spleen/data/imagesTr/spleen_19.nii.gz evaluation/ct-spleen/data-local/ -Force
Copy-Item evaluation/ct-spleen/data/imagesTr/spleen_29.nii.gz evaluation/ct-spleen/data-local/ -Force
Copy-Item evaluation/ct-spleen/data/imagesTs/spleen_1.nii.gz evaluation/ct-spleen/data-local/ -Force
Copy-Item evaluation/ct-spleen/data/imagesTs/spleen_15.nii.gz evaluation/ct-spleen/data-local/ -Force
Copy-Item evaluation/ct-spleen/data/labelsTr/spleen_10.nii.gz evaluation/ct-spleen/data-local/labels/final/ -Force
Copy-Item evaluation/ct-spleen/data/labelsTr/spleen_19.nii.gz evaluation/ct-spleen/data-local/labels/final/ -Force
Copy-Item evaluation/ct-spleen/data/labelsTr/spleen_29.nii.gz evaluation/ct-spleen/data-local/labels/final/ -Force
docker compose restart monai-label | Out-Null
Write-Ok "Studies folder ready; MONAI Label restarted"

# ------------------------------------------------------------
# 4. Python deps for the DICOM conversion
# ------------------------------------------------------------
Write-Step "Installing Python packages for DICOM conversion"
python -m pip install --quiet -r evaluation/ct-spleen/requirements.txt
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ❌ Python package installation failed." -ForegroundColor Red
    exit 1
}
Write-Ok "pydicom + requests ready"

# ------------------------------------------------------------
# 5. NIfTI -> DICOM conversion + Orthanc upload
# ------------------------------------------------------------
Write-Step "Converting MSD NIfTI volumes to DICOM and uploading to Orthanc"
python scripts/prepare-msd-for-orthanc.py `
    --cases evaluation/ct-spleen/cases.json `
    --data evaluation/ct-spleen/data `
    --orthanc http://localhost:8042
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ❌ DICOM conversion/upload failed." -ForegroundColor Red
    exit 1
}
Write-Ok "5 studies converted and uploaded to Orthanc"

# ------------------------------------------------------------
# 6. Register cases with the uncertainty service
# ------------------------------------------------------------
Write-Step "Registering the 5 evaluation cases"
$Cases = Get-Content evaluation/ct-spleen/cases.json | ConvertFrom-Json
$registered = 0
foreach ($case in $Cases) {
    if (-not $case.msd_case) { continue }
    $body = @{
        case_id   = $case.study_uid
        patient_id = $case.patient_id
        study_uid = $case.study_uid
        series_uid = $case.series_uid
        condition = "C2"
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "http://localhost:8043/uncertainty/cases" -Method Post `
        -ContentType "application/json" -Body $body | Out-Null
    $registered++
    Write-Ok "Registered $($case.patient_id)"
}
if ($registered -ne 5) {
    Write-Host "  ⚠ Expected 5 MSD cases, registered $registered" -ForegroundColor Yellow
}

# ------------------------------------------------------------
# 7. Generate C2 inferences (the slow step)
# ------------------------------------------------------------
Write-Step "Generating the C2 inferences (MC Dropout, T=16)"
Write-Host "     Each case takes ~3-5 minutes on CPU. Total: ~20 minutes."
Write-Host "     Watch MONAI progress with:  docker logs medical-monai --tail 20"
docker exec medical-uncertainty python /app/scripts/precompute_cases.py `
    --cases /evaluation/cases.json `
    --condition C2 `
    --report /tmp/precompute.json
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ⚠ Precompute reported failures (DET rows are expected)." -ForegroundColor Yellow
}

# ------------------------------------------------------------
# 8. Done — tell the tester what to do next
# ------------------------------------------------------------
Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║   ✅ Demo data is ready!                          ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Open the reviewer:  http://localhost:3000/uncertainty-review?reviewer=R01&condition=C2"
Write-Host "  Open OHIF viewer:   http://localhost:3000"
Write-Host "  Check the report:   run the commands in evaluation/ct-spleen/README.md"
Write-Host ""
