# ============================================
# MONAI Label API Test Script
# Location: scripts/test-monai-label.ps1
# ============================================

param(
    [string]$MonaiUrl = "http://localhost:8000",
    [switch]$Verbose
)

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  MONAI Label API Test Suite" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$totalTests = 0
$passedTests = 0

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Url,
        [string]$Method = "GET",
        [string]$ExpectedField = $null
    )
    
    $script:totalTests++
    Write-Host "[$script:totalTests] Testing: $Name" -ForegroundColor Yellow
    
    try {
        $response = Invoke-RestMethod -Uri $Url -Method $Method -TimeoutSec 10
        
        if ($ExpectedField -and -not $response.$ExpectedField) {
            Write-Host "    ⚠️  Response missing expected field: $ExpectedField" -ForegroundColor Yellow
            return $false
        }
        
        Write-Host "    ✅ PASSED" -ForegroundColor Green
        
        if ($Verbose) {
            Write-Host "    Response: $($response | ConvertTo-Json -Compress)" -ForegroundColor Gray
        }
        
        $script:passedTests++
        return $response
    }
    catch {
        Write-Host "    ❌ FAILED: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

# ============================================
# Test 1: Server Info
# ============================================
$info = Test-Endpoint -Name "Server Info" -Url "$MonaiUrl/info" -ExpectedField "name"

if ($info) {
    Write-Host ""
    Write-Host "  Server Details:" -ForegroundColor White
    Write-Host "    Name: $($info.name)" -ForegroundColor Gray
    Write-Host "    Version: $($info.version)" -ForegroundColor Gray
    if ($info.models) {
        Write-Host "    Models: $($info.models.PSObject.Properties.Name -join ', ')" -ForegroundColor Gray
    }
    Write-Host ""
}

# ============================================
# Test 2: List Models
# ============================================
$models = Test-Endpoint -Name "List Models" -Url "$MonaiUrl/model/"

if ($models) {
    Write-Host ""
    Write-Host "  Available Models:" -ForegroundColor White
    foreach ($model in $models) {
        $modelName = if ($model.name) { $model.name } else { $model }
        Write-Host "    • $modelName" -ForegroundColor Gray
    }
    Write-Host ""
}

# ============================================
# Test 3: DeepEdit Model Info (if available)
# ============================================
Test-Endpoint -Name "DeepEdit Model Details" -Url "$MonaiUrl/model/deepedit" | Out-Null

# ============================================
# Test 4: Segmentation Spleen Model (if available)
# ============================================
Test-Endpoint -Name "Spleen Model Details" -Url "$MonaiUrl/model/segmentation_spleen" | Out-Null

# ============================================
# Test 5: Datastore Info
# ============================================
$datastore = Test-Endpoint -Name "Datastore Info" -Url "$MonaiUrl/datastore/"

if ($datastore) {
    Write-Host ""
    Write-Host "  Datastore:" -ForegroundColor White
    $imageCount = if ($datastore.total) { $datastore.total } elseif ($datastore.objects) { $datastore.objects.Count } else { "Unknown" }
    Write-Host "    Images: $imageCount" -ForegroundColor Gray
    Write-Host ""
}

# ============================================
# Test 6: Active Learning Strategy
# ============================================
Test-Endpoint -Name "Active Learning Info" -Url "$MonaiUrl/activelearning/" | Out-Null

# ============================================
# Test 7: Scoring Endpoint
# ============================================
Test-Endpoint -Name "Scoring Info" -Url "$MonaiUrl/scoring/" | Out-Null

# ============================================
# Test 8: Logs Endpoint (if available)
# ============================================
Test-Endpoint -Name "Server Logs" -Url "$MonaiUrl/logs/?lines=5" | Out-Null

# ============================================
# Summary
# ============================================
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Test Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$percentage = [math]::Round(($passedTests / $totalTests) * 100)

if ($passedTests -eq $totalTests) {
    Write-Host "  All tests passed! ($passedTests/$totalTests)" -ForegroundColor Green
} elseif ($passedTests -gt 0) {
    Write-Host "  $passedTests/$totalTests tests passed ($percentage%)" -ForegroundColor Yellow
} else {
    Write-Host "  All tests failed! Is MONAI Label running?" -ForegroundColor Red
}

Write-Host ""
Write-Host "  MONAI Label URL: $MonaiUrl" -ForegroundColor Gray
Write-Host "  Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Gray
Write-Host ""

# ============================================
# Quick Reference URLs
# ============================================
Write-Host "Quick Reference:" -ForegroundColor White
Write-Host "  Server Info:    $MonaiUrl/info" -ForegroundColor Gray
Write-Host "  Models List:    $MonaiUrl/model/" -ForegroundColor Gray
Write-Host "  Datastore:      $MonaiUrl/datastore/" -ForegroundColor Gray
Write-Host "  Web UI:         $MonaiUrl" -ForegroundColor Gray
Write-Host ""

# Return exit code based on results
if ($passedTests -eq $totalTests) {
    exit 0
} else {
    exit 1
}
