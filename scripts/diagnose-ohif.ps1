# Medical Imaging Platform - OHIF Diagnostic Script
# Tests all DICOMweb endpoints needed by OHIF
# Place at: C:\medical-imaging-platform\scripts\diagnose-ohif.ps1

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "OHIF Viewer Diagnostics" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

$allPassed = $true

# ============================================
# Test 1: Orthanc Direct Access
# ============================================
Write-Host "[1/6] Testing Orthanc direct access..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest "http://localhost:8042/system" -UseBasicParsing -TimeoutSec 5
    Write-Host "  OK - Orthanc is accessible" -ForegroundColor Green
} catch {
    Write-Host "  FAIL - Cannot reach Orthanc" -ForegroundColor Red
    $allPassed = $false
}

# ============================================
# Test 2: Nginx Proxy
# ============================================
Write-Host "[2/6] Testing nginx proxy..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest "http://localhost:8080/system" -UseBasicParsing -TimeoutSec 5
    Write-Host "  OK - Nginx proxy is working" -ForegroundColor Green
    
    # Check CORS headers
    if ($response.Headers.'Access-Control-Allow-Origin') {
        Write-Host "  OK - CORS headers present" -ForegroundColor Green
    } else {
        Write-Host "  WARNING - CORS headers missing" -ForegroundColor Yellow
        Write-Host "    This will cause image loading to fail!" -ForegroundColor Red
        $allPassed = $false
    }
} catch {
    Write-Host "  FAIL - Cannot reach nginx proxy" -ForegroundColor Red
    $allPassed = $false
}

# ============================================
# Test 3: QIDO-RS (Study List)
# ============================================
Write-Host "[3/6] Testing QIDO-RS endpoint..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest "http://localhost:8080/dicom-web/studies" -UseBasicParsing -TimeoutSec 10
    Write-Host "  OK - QIDO-RS is responding" -ForegroundColor Green
    
    $studies = $response.Content | ConvertFrom-Json
    Write-Host "    Found $($studies.Count) studies" -ForegroundColor Gray
    
    # Store first study UID for later tests
    if ($studies.Count -gt 0) {
        $script:testStudyUID = $studies[0].'0020000D'.Value[0]
        Write-Host "    Test Study UID: $script:testStudyUID" -ForegroundColor Gray
    }
} catch {
    Write-Host "  FAIL - QIDO-RS not working" -ForegroundColor Red
    Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Gray
    $allPassed = $false
}

# ============================================
# Test 4: WADO-RS (Image Retrieval)
# ============================================
Write-Host "[4/6] Testing WADO-RS endpoint..." -ForegroundColor Yellow
if ($script:testStudyUID) {
    try {
        # Get series for the study
        $response = Invoke-WebRequest "http://localhost:8080/dicom-web/studies/$script:testStudyUID/series" -UseBasicParsing -TimeoutSec 10
        Write-Host "  OK - WADO-RS is responding" -ForegroundColor Green
        
        $series = $response.Content | ConvertFrom-Json
        Write-Host "    Found $($series.Count) series" -ForegroundColor Gray
    } catch {
        Write-Host "  FAIL - WADO-RS not working" -ForegroundColor Red
        Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Gray
        $allPassed = $false
    }
} else {
    Write-Host "  SKIP - No studies available for testing" -ForegroundColor Yellow
}

# ============================================
# Test 5: WADO-URI (Legacy)
# ============================================
Write-Host "[5/6] Testing WADO-URI endpoint..." -ForegroundColor Yellow
try {
    # Just test if the endpoint exists
    $response = Invoke-WebRequest "http://localhost:8080/wado" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    Write-Host "  OK - WADO-URI endpoint exists" -ForegroundColor Green
} catch {
    # 400 is expected without proper parameters, but means endpoint exists
    if ($_.Exception.Response.StatusCode -eq 400) {
        Write-Host "  OK - WADO-URI endpoint exists (400 is expected)" -ForegroundColor Green
    } else {
        Write-Host "  WARNING - WADO-URI may not be configured" -ForegroundColor Yellow
        Write-Host "    This might cause issues with some viewers" -ForegroundColor Gray
    }
}

# ============================================
# Test 6: Browser CORS Test
# ============================================
Write-Host "[6/6] Checking browser CORS compatibility..." -ForegroundColor Yellow
Write-Host "  Please check browser console for CORS errors" -ForegroundColor Gray
Write-Host "  Open: http://localhost:3000" -ForegroundColor Cyan
Write-Host "  Press F12 > Console tab" -ForegroundColor Gray
Write-Host "  Look for 'Access-Control-Allow-Origin' errors" -ForegroundColor Gray

# ============================================
# Summary
# ============================================
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan

if ($allPassed) {
    Write-Host "All Tests Passed!" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "If images still don't load in OHIF:" -ForegroundColor White
    Write-Host "  1. Clear browser cache (Ctrl+Shift+Del)" -ForegroundColor Gray
    Write-Host "  2. Hard refresh OHIF (Ctrl+F5)" -ForegroundColor Gray
    Write-Host "  3. Check browser console for errors (F12)" -ForegroundColor Gray
    Write-Host "  4. Try a different browser" -ForegroundColor Gray
} else {
    Write-Host "Some Tests Failed!" -ForegroundColor Red
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Action Required:" -ForegroundColor Yellow
    Write-Host "  1. Update nginx.conf with the fixed version" -ForegroundColor Gray
    Write-Host "  2. Restart services: docker-compose restart orthanc-proxy" -ForegroundColor Gray
    Write-Host "  3. Run this diagnostic again" -ForegroundColor Gray
}

Write-Host ""

# ============================================
# Additional Debug Info
# ============================================
Write-Host "Debug Commands:" -ForegroundColor White
Write-Host "  View nginx logs: docker logs medical-orthanc-proxy" -ForegroundColor Gray
Write-Host "  View Orthanc logs: docker logs medical-orthanc" -ForegroundColor Gray
Write-Host "  Restart proxy: docker-compose restart orthanc-proxy" -ForegroundColor Gray
Write-Host ""
