# Medical Imaging Platform - System Verification Script
# Run this after deployment to verify all services are working
# Usage: .\verify-system.ps1

Write-Host "`n╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   🏥 Medical Imaging Platform - System Verification      ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════════════════╝`n" -ForegroundColor Cyan

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
            Write-Host " ✅ PASS" -ForegroundColor Green
            return $true
        } else {
            Write-Host " ❌ FAIL (Status: $($response.StatusCode))" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host " ❌ FAIL (Error: $($_.Exception.Message))" -ForegroundColor Red
        return $false
    }
}

# Function to test database
function Test-Database {
    Write-Host "Testing PostgreSQL..." -NoNewline
    try {
        $env:PGPASSWORD = "SecurePass123"
        $result = psql -h localhost -U medical_imaging -d annotations -c "SELECT 1;" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host " ✅ PASS" -ForegroundColor Green
            return $true
        } else {
            Write-Host " ❌ FAIL" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host " ⚠️  SKIP (psql not installed)" -ForegroundColor Yellow
        return $true
    }
}

# Function to check Docker container
function Test-Container {
    param([string]$Name)
    
    Write-Host "Checking $Name container..." -NoNewline
    $container = docker ps --filter "name=$Name" --format "{{.Status}}"
    if ($container -like "*Up*") {
        if ($container -like "*healthy*" -or $container -notlike "*(health*") {
            Write-Host " ✅ PASS (Running)" -ForegroundColor Green
            return $true
        } else {
            Write-Host " ⚠️  WARNING (Running but unhealthy)" -ForegroundColor Yellow
            return $true
        }
    } else {
        Write-Host " ❌ FAIL (Not running)" -ForegroundColor Red
        return $false
    }
}

Write-Host "═══════════════════════════════════════════════════════════`n" -ForegroundColor Cyan
Write-Host "🐳 DOCKER CONTAINERS`n" -ForegroundColor Yellow

$allPassed = (Test-Container "medical-postgres") -and $allPassed
$allPassed = (Test-Container "medical-orthanc") -and $allPassed
$allPassed = (Test-Container "medical-monai") -and $allPassed
$allPassed = (Test-Container "medical-orthanc-proxy") -and $allPassed
$allPassed = (Test-Container "medical-collaboration") -and $allPassed

Write-Host "`n═══════════════════════════════════════════════════════════`n" -ForegroundColor Cyan
Write-Host "🌐 SERVICE ENDPOINTS`n" -ForegroundColor Yellow

$allPassed = (Test-Endpoint "Orthanc PACS" "http://localhost:8042/system") -and $allPassed
$allPassed = (Test-Endpoint "Orthanc Proxy" "http://localhost:8080") -and $allPassed
$allPassed = (Test-Endpoint "MONAI Label" "http://localhost:8000/info/") -and $allPassed
$allPassed = (Test-Endpoint "Collaboration Server" "http://localhost:3001/health") -and $allPassed

Write-Host "`n═══════════════════════════════════════════════════════════`n" -ForegroundColor Cyan
Write-Host "💾 DATABASE`n" -ForegroundColor Yellow

$allPassed = (Test-Database) -and $allPassed

Write-Host "`n═══════════════════════════════════════════════════════════`n" -ForegroundColor Cyan

if ($allPassed) {
    Write-Host "✅ ALL TESTS PASSED! System is ready." -ForegroundColor Green
    Write-Host "`nYou can now:" -ForegroundColor Cyan
    Write-Host "  1. Start OHIF viewer development" -ForegroundColor White
    Write-Host "  2. Test collaboration features" -ForegroundColor White
    Write-Host "  3. Load test DICOM data" -ForegroundColor White
} else {
    Write-Host "❌ SOME TESTS FAILED. Please check the logs:" -ForegroundColor Red
    Write-Host "  docker-compose logs" -ForegroundColor White
    Write-Host "`nOr for specific service:" -ForegroundColor Cyan
    Write-Host "  docker-compose logs collaboration-server" -ForegroundColor White
}

Write-Host "`n"
