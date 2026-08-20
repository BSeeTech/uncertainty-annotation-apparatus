# Medical Imaging Platform - Test Script
# Place at: C:\medical-imaging-platform\scripts\test.ps1
# Version: 1.1 (CORRECTED)

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Medical Imaging Platform - Health Check" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Navigate to project root
Set-Location "C:\medical-imaging-platform"

$allPassed = $true

# ============================================
# Test 1: Docker Status
# ============================================
Write-Host "[1/6] Checking Docker..." -ForegroundColor Yellow
$dockerStatus = docker version 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  OK - Docker is running" -ForegroundColor Green
} else {
    Write-Host "  FAIL - Docker is not running" -ForegroundColor Red
    $allPassed = $false
    Write-Host ""
    Write-Host "Please start Docker Desktop and try again." -ForegroundColor Yellow
    exit 1
}

# ============================================
# Test 2: Container Status
# ============================================
Write-Host "[2/6] Checking containers..." -ForegroundColor Yellow

$containers = @("medical-orthanc", "medical-monai", "medical-postgres")
foreach ($container in $containers) {
    $status = docker ps --filter "name=$container" --format "{{.Status}}" 2>&1
    if ($status -match "Up") {
        Write-Host "  OK - $container is running" -ForegroundColor Green
    } else {
        Write-Host "  FAIL - $container is not running" -ForegroundColor Red
        $allPassed = $false
    }
}

# ============================================
# Test 3: Orthanc API
# ============================================
Write-Host "[3/6] Checking Orthanc API..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest "http://localhost:8042/system" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    if ($response.StatusCode -eq 200) {
        Write-Host "  OK - Orthanc API is responding" -ForegroundColor Green
        
        # Parse and display system info
        $systemInfo = $response.Content | ConvertFrom-Json
        Write-Host "    Version: $($systemInfo.Version)" -ForegroundColor Gray
        Write-Host "    Name: $($systemInfo.Name)" -ForegroundColor Gray
    }
} catch {
    Write-Host "  FAIL - Orthanc API not responding" -ForegroundColor Red
    Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Gray
    $allPassed = $false
}

# ============================================
# Test 4: DICOMweb Endpoint
# ============================================
Write-Host "[4/6] Checking DICOMweb..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest "http://localhost:8042/dicom-web/studies" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    Write-Host "  OK - DICOMweb is enabled" -ForegroundColor Green
    
    # Parse response to count studies
    $studies = $response.Content | ConvertFrom-Json
    Write-Host "    Studies in PACS: $($studies.Count)" -ForegroundColor Gray
} catch {
    if ($_.Exception.Response.StatusCode -eq 404) {
        Write-Host "  FAIL - DICOMweb endpoint not found (404)" -ForegroundColor Red
        Write-Host "    Check Orthanc DICOMweb plugin configuration" -ForegroundColor Gray
    } else {
        Write-Host "  FAIL - DICOMweb not responding" -ForegroundColor Red
        Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Gray
    }
    $allPassed = $false
}

# ============================================
# Test 5: MONAI Label
# ============================================
Write-Host "[5/6] Checking MONAI Label..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest "http://localhost:8000/info" -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    Write-Host "  OK - MONAI Label is responding" -ForegroundColor Green
    
    # Parse and display info
    $monaiInfo = $response.Content | ConvertFrom-Json
    Write-Host "    Version: $($monaiInfo.version)" -ForegroundColor Gray
    if ($monaiInfo.models) {
        Write-Host "    Models: $($monaiInfo.models.Count) available" -ForegroundColor Gray
    }
} catch {
    Write-Host "  FAIL - MONAI Label not responding" -ForegroundColor Red
    Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Gray
    Write-Host "    Note: MONAI may take 60-90 seconds to start" -ForegroundColor Yellow
    $allPassed = $false
}

# ============================================
# Test 6: PostgreSQL
# ============================================
Write-Host "[6/6] Checking PostgreSQL..." -ForegroundColor Yellow
try {
    $pgTest = docker exec medical-postgres pg_isready -U medical_imaging -d annotations 2>&1
    
    # Check exit code instead of string matching for reliability
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  OK - PostgreSQL is accepting connections" -ForegroundColor Green
        
        # Check if tables exist
        $tableCheck = docker exec medical-postgres psql -U medical_imaging -d annotations -c "\dt" 2>&1
        if ($tableCheck -match "sessions" -and $tableCheck -match "annotations") {
            Write-Host "    Database schema initialized" -ForegroundColor Gray
        } else {
            Write-Host "    Warning: Database tables may not be initialized" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  FAIL - PostgreSQL not ready" -ForegroundColor Red
        Write-Host "    Output: $pgTest" -ForegroundColor Gray
        $allPassed = $false
    }
} catch {
    Write-Host "  FAIL - PostgreSQL container not found or not responding" -ForegroundColor Red
    Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Gray
    $allPassed = $false
}

# ============================================
# Summary
# ============================================
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan

if ($allPassed) {
    Write-Host "All Tests Passed!" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "System is ready for use!" -ForegroundColor White
    Write-Host ""
    Write-Host "Next Steps:" -ForegroundColor White
    Write-Host "  1. Upload DICOM studies to Orthanc" -ForegroundColor Gray
    Write-Host "  2. Start OHIF viewer separately" -ForegroundColor Gray
    Write-Host "  3. Access OHIF at: http://localhost:3000" -ForegroundColor Gray
} else {
    Write-Host "Some Tests Failed" -ForegroundColor Red
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Troubleshooting:" -ForegroundColor Yellow
    Write-Host "  1. Check Docker logs: docker-compose logs" -ForegroundColor Gray
    Write-Host "  2. Check specific service: docker logs medical-orthanc" -ForegroundColor Gray
    Write-Host "  3. Restart services using stop and start scripts" -ForegroundColor Gray
    Write-Host "  4. Check environment file configuration" -ForegroundColor Gray
}

Write-Host ""
