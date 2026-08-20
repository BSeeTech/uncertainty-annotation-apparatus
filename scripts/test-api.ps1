# ============================================
# Medical Imaging Platform - API Test Suite
# ============================================

Write-Host "`n🧪 Testing Collaboration Server API..." -ForegroundColor Cyan

# Test 1: Health Check
Write-Host "`nTest 1: Health Endpoint" -NoNewline
try {
    $response = Invoke-RestMethod -Uri "http://localhost:3001/health" -Method Get
    if ($response.status -eq "ok") {
        Write-Host " ✅ PASS" -ForegroundColor Green
        Write-Host "  Response: $($response | ConvertTo-Json -Compress)" -ForegroundColor Gray
    }
} catch {
    Write-Host " ❌ FAIL" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 2: Create Session
Write-Host "`nTest 2: Create Session" -NoNewline
try {
    $body = @{
        studyInstanceUID = "test-study-123"
        userId = "test-user-1"
    } | ConvertTo-Json

    $response = Invoke-RestMethod -Uri "http://localhost:3001/api/sessions" `
        -Method Post `
        -ContentType "application/json" `
        -Body $body

    if ($response.sessionId) {
        Write-Host " ✅ PASS" -ForegroundColor Green
        Write-Host "  Session ID: $($response.sessionId)" -ForegroundColor Gray
        $global:testSessionId = $response.sessionId
    }
} catch {
    Write-Host " ❌ FAIL" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 3: Get Session Details
if ($global:testSessionId) {
    Write-Host "`nTest 3: Get Session Details" -NoNewline
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:3001/api/sessions/$($global:testSessionId)" -Method Get
        Write-Host " ✅ PASS" -ForegroundColor Green
        Write-Host "  Session: $($response | ConvertTo-Json -Compress)" -ForegroundColor Gray
    } catch {
        Write-Host " ❌ FAIL" -ForegroundColor Red
        Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host "`n✅ API tests complete!`n" -ForegroundColor Green