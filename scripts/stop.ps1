# Medical Imaging Platform - Stop Script
# Place at: C:\medical-imaging-platform\scripts\stop.ps1
# Version: 1.2 (CLEAN)

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Medical Imaging Platform - Shutdown" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Navigate to project root
Set-Location "C:\medical-imaging-platform"

# Check if Docker is running
$dockerStatus = docker version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Docker is not running!" -ForegroundColor Red
    Write-Host "Services may already be stopped." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

# Show current services
Write-Host "Current services:" -ForegroundColor Yellow
docker compose ps
Write-Host ""

# Stop services
Write-Host "Stopping services..." -ForegroundColor Yellow
docker compose down

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "All services stopped successfully!" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Data Persistence:" -ForegroundColor White
    Write-Host "  DICOM images preserved in Docker volumes" -ForegroundColor Green
    Write-Host "  Database preserved in Docker volumes" -ForegroundColor Green
    Write-Host "  MONAI data preserved in Docker volumes" -ForegroundColor Green
    Write-Host ""
    Write-Host "To completely remove all data:" -ForegroundColor Yellow
    Write-Host "  docker compose down -v" -ForegroundColor Red
    Write-Host ""
    Write-Host "To restart services:" -ForegroundColor Yellow
    Write-Host "  Run start script" -ForegroundColor Cyan
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "ERROR: Failed to stop services!" -ForegroundColor Red
    Write-Host "Check the output above for error details." -ForegroundColor Yellow
    Write-Host ""
}
