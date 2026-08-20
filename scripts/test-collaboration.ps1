# ============================================
# Collaboration Feature Test Script
# Location: scripts/test-collaboration.ps1
# ============================================

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Collaboration Feature Test Suite" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Configuration
$COLLAB_SERVER = "http://localhost:3001"
$OHIF_SERVER = "http://localhost:3000"

# Test 1: Health Check
Write-Host "[Test 1] Collaboration Server Health Check..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "$COLLAB_SERVER/health" -Method Get
    Write-Host "  ✅ Server is healthy" -ForegroundColor Green
    Write-Host "  Active Sessions: $($health.activeSessions)" -ForegroundColor Gray
} catch {
    Write-Host "  ❌ Server not responding: $_" -ForegroundColor Red
    exit 1
}

# Test 2: Create Session via API
Write-Host ""
Write-Host "[Test 2] Create Session via REST API..." -ForegroundColor Yellow
$testStudyUID = "1.2.3.4.5.6.7.8.9.0"
$testUserId = "test-user-$(Get-Random)"

$body = @{
    studyInstanceUID = $testStudyUID
    userId = $testUserId
} | ConvertTo-Json

try {
    $session = Invoke-RestMethod -Uri "$COLLAB_SERVER/api/sessions" -Method Post -Body $body -ContentType "application/json"
    Write-Host "  ✅ Session created: $($session.sessionId)" -ForegroundColor Green
    $testSessionId = $session.sessionId
} catch {
    Write-Host "  ❌ Failed to create session: $_" -ForegroundColor Red
    exit 1
}

# Test 3: Get Session Details
Write-Host ""
Write-Host "[Test 3] Retrieve Session Details..." -ForegroundColor Yellow
try {
    $sessionDetails = Invoke-RestMethod -Uri "$COLLAB_SERVER/api/sessions/$testSessionId" -Method Get
    Write-Host "  ✅ Session retrieved successfully" -ForegroundColor Green
    Write-Host "  Study UID: $($sessionDetails.study_instance_uid)" -ForegroundColor Gray
} catch {
    Write-Host "  ❌ Failed to get session: $_" -ForegroundColor Red
}

# Test 4: List Active Sessions
Write-Host ""
Write-Host "[Test 4] List Active Sessions..." -ForegroundColor Yellow
try {
    $sessions = Invoke-RestMethod -Uri "$COLLAB_SERVER/api/sessions" -Method Get
    Write-Host "  ✅ Found $($sessions.Count) active session(s)" -ForegroundColor Green
} catch {
    Write-Host "  ❌ Failed to list sessions: $_" -ForegroundColor Red
}

# Test 5: OHIF Viewer Availability
Write-Host ""
Write-Host "[Test 5] OHIF Viewer Availability..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri $OHIF_SERVER -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) {
        Write-Host "  ✅ OHIF Viewer is running" -ForegroundColor Green
    }
} catch {
    Write-Host "  ⚠️ OHIF Viewer not responding (may still be starting)" -ForegroundColor Yellow
}

# Test 6: Close Test Session
Write-Host ""
Write-Host "[Test 6] Close Test Session..." -ForegroundColor Yellow
try {
    $closed = Invoke-RestMethod -Uri "$COLLAB_SERVER/api/sessions/$testSessionId/close" -Method Post
    Write-Host "  ✅ Session closed: $($closed.sessionId)" -ForegroundColor Green
} catch {
    Write-Host "  ❌ Failed to close session: $_" -ForegroundColor Red
}

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Test Suite Complete" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Manual Testing URLs:" -ForegroundColor White
Write-Host "  OHIF Viewer:    $OHIF_SERVER" -ForegroundColor Gray
Write-Host "  Collab Health:  $COLLAB_SERVER/health" -ForegroundColor Gray
Write-Host "  API Sessions:   $COLLAB_SERVER/api/sessions" -ForegroundColor Gray
Write-Host ""
Write-Host "To test with real DICOM data:" -ForegroundColor White
Write-Host "  1. Upload a study to Orthanc" -ForegroundColor Gray
Write-Host "  2. Open: $OHIF_SERVER/collaboration?StudyInstanceUIDs=<STUDY_UID>" -ForegroundColor Gray
Write-Host "  3. Create/Join sessions from the Collaboration panel" -ForegroundColor Gray
