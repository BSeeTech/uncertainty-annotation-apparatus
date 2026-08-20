# Medical Imaging Platform - Start Script
# Place at: C:\medical-imaging-platform\scripts\start.ps1
# Version: 1.1 (CORRECTED)

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Medical Imaging Platform - Startup" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Navigate to project root
Set-Location "C:\medical-imaging-platform"

# ============================================
# Pre-flight Checks
# ============================================
Write-Host "[1/4] Pre-flight checks..." -ForegroundColor Yellow

# Check if Docker is running
$dockerStatus = docker version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Docker is not running!" -ForegroundColor Red
    Write-Host "Please start Docker Desktop and try again." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "  OK - Docker is running" -ForegroundColor Green

# Check if .env file exists
if (-not (Test-Path ".\.env")) {
    Write-Host "ERROR: .env file not found!" -ForegroundColor Red
    Write-Host "Please create .env file in the project root." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "  OK - .env file found" -ForegroundColor Green

# Check if docker-compose.yml exists
if (-not (Test-Path ".\docker-compose.yml")) {
    Write-Host "ERROR: docker-compose.yml not found!" -ForegroundColor Red
    Write-Host "Please ensure docker-compose.yml is in the project root." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "  OK - docker-compose.yml found" -ForegroundColor Green

# Check if Orthanc config exists
if (-not (Test-Path ".\servers\orthanc\orthanc.json")) {
    Write-Host "WARNING: Orthanc config not found at .\servers\orthanc\orthanc.json" -ForegroundColor Yellow
}

Write-Host ""

# ============================================
# Start Services
# ============================================
Write-Host "[2/4] Starting Docker services..." -ForegroundColor Yellow
docker compose up -d

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to start services!" -ForegroundColor Red
    Write-Host "Check the output above for error details." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "  OK - Services started" -ForegroundColor Green
Write-Host ""

# ============================================
# Wait for Services
# ============================================
Write-Host "[3/4] Waiting for services to initialize..." -ForegroundColor Yellow
Write-Host "  (This may take 30-60 seconds)" -ForegroundColor Gray

$waitTime = 30
for ($i = 1; $i -le $waitTime; $i++) {
    Write-Progress -Activity "Initializing services" -Status "$i of $waitTime seconds" -PercentComplete (($i / $waitTime) * 100)
    Start-Sleep -Seconds 1
}
Write-Progress -Activity "Initializing services" -Completed

Write-Host "  OK - Initialization complete" -ForegroundColor Green
Write-Host ""

# ============================================
# Show Service Status
# ============================================
Write-Host "[4/4] Service status:" -ForegroundColor Yellow
docker compose ps
Write-Host ""

# ============================================
# Access Information
# ============================================
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Services are starting!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Access Points:" -ForegroundColor White
Write-Host "  Orthanc PACS:   http://localhost:8042" -ForegroundColor Cyan
Write-Host "  MONAI Label:    http://localhost:8000" -ForegroundColor Cyan
Write-Host "  PostgreSQL:     localhost:5432" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor White
Write-Host "  1. Verify services with test script" -ForegroundColor Gray
Write-Host "  2. Upload DICOM data to Orthanc" -ForegroundColor Gray
Write-Host "  3. Start OHIF viewer separately" -ForegroundColor Gray
Write-Host ""
Write-Host "To stop services, run stop script" -ForegroundColor Yellow
Write-Host ""
