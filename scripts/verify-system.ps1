# Medical Imaging Platform - System Verification Script
# Run this after deployment to verify all services are working
# Usage: .\verify-system.ps1

Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host "    Medical Imaging Platform - System Verification" -ForegroundColor Cyan
Write-Host "============================================================`n" -ForegroundColor Cyan

$allPassed = $true

# Function to test endpoint
function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Url,
        [int]$ExpectedStatus = 200
    )
    
    Write-Host "Testing $Name..." -NoNewline
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        if ($response.StatusCode -eq $ExpectedStatus) {
            Write-Host " [PASS]" -ForegroundColor Green
            return $true
        } else {
            Write-Host " [FAIL] (Status: $($response.StatusCode))" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host " [FAIL] (Error: $($_.Exception.Message))" -ForegroundColor Red
        return $false
    }
}

# Function to test database
function Test-Database {
    Write-Host "Testing PostgreSQL..." -NoNewline
    try {
        $result = docker exec medical-postgres psql -U medical_imaging -d annotations -At -c "SELECT 1;" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host " [PASS]" -ForegroundColor Green
            return $true
        } else {
            Write-Host " [FAIL]" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host " [FAIL] ($($_.Exception.Message))" -ForegroundColor Red
        return $false
    }
}

# Function to check Docker container
function Test-Container {
    param([string]$Name)
    
    Write-Host "Checking $Name container..." -NoNewline
    $container = docker ps --filter "name=$Name" --format "{{.Status}}"
    if ($container -like "*Up*") {
        if ($container -like "*healthy*" -or $container -notlike "*(health*") {
            Write-Host " [PASS] (Running)" -ForegroundColor Green
            return $true
        } else {
            Write-Host " [FAIL] (Running but unhealthy)" -ForegroundColor Red
            return $false
        }
    } else {
        Write-Host " [FAIL] (Not running)" -ForegroundColor Red
        return $false
    }
}

Write-Host "============================================================`n" -ForegroundColor Cyan
Write-Host "DOCKER CONTAINERS`n" -ForegroundColor Yellow

$allPassed = (Test-Container "medical-postgres") -and $allPassed
$allPassed = (Test-Container "medical-orthanc") -and $allPassed
$allPassed = (Test-Container "medical-monai") -and $allPassed
$allPassed = (Test-Container "medical-uncertainty") -and $allPassed
$allPassed = (Test-Container "medical-nginx") -and $allPassed
$allPassed = (Test-Container "medical-collaboration") -and $allPassed

Write-Host "`n============================================================`n" -ForegroundColor Cyan
Write-Host "SERVICE ENDPOINTS`n" -ForegroundColor Yellow

$allPassed = (Test-Endpoint "Orthanc PACS" "http://localhost:8042/system") -and $allPassed
$allPassed = (Test-Endpoint "Uncertainty API" "http://localhost:8043/uncertainty/health/ready") -and $allPassed
$allPassed = (Test-Endpoint "DICOMweb Gateway" "http://localhost:8043/dicom-web/studies") -and $allPassed
$allPassed = (Test-Endpoint "MONAI Label" "http://localhost:8000/info/") -and $allPassed
$allPassed = (Test-Endpoint "Collaboration Server" "http://localhost:3001/health") -and $allPassed

Write-Host "`n============================================================`n" -ForegroundColor Cyan
Write-Host "DATABASE`n" -ForegroundColor Yellow

$allPassed = (Test-Database) -and $allPassed

Write-Host "`n============================================================`n" -ForegroundColor Cyan

if ($allPassed) {
    Write-Host "[PASS] ALL TESTS PASSED! System is ready." -ForegroundColor Green
    Write-Host "`nYou can now:" -ForegroundColor Cyan
    Write-Host "  1. Start OHIF viewer development" -ForegroundColor White
    Write-Host "  2. Test collaboration features" -ForegroundColor White
    Write-Host "  3. Load test DICOM data" -ForegroundColor White
} else {
    Write-Host "[FAIL] SOME TESTS FAILED. Please check the logs:" -ForegroundColor Red
    Write-Host "  docker-compose logs" -ForegroundColor White
    Write-Host "`nOr for specific service:" -ForegroundColor Cyan
    Write-Host "  docker-compose logs collaboration-server" -ForegroundColor White
}

Write-Host "`n"
if ($allPassed) {
    exit 0
}
exit 1
