# ============================================
# upload-dicom.ps1
# Upload DICOM folder to Orthanc PACS
# 
# Location: scripts/upload-dicom.ps1
# Usage: .\scripts\upload-dicom.ps1 -Path "C:\dicom\folder"
# ============================================

param(
    [Parameter(Mandatory=$true, HelpMessage="Path to DICOM folder")]
    [string]$Path,
    
    [Parameter(HelpMessage="Orthanc server URL")]
    [string]$OrthancUrl = "http://localhost:8042",
    
    [Parameter(HelpMessage="Show progress for each file")]
    [switch]$Verbose
)

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  DICOM Upload to Orthanc" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Validate path
if (-not (Test-Path $Path)) {
    Write-Host "Error: Path does not exist: $Path" -ForegroundColor Red
    exit 1
}

Write-Host "Source:  $Path" -ForegroundColor Gray
Write-Host "Target:  $OrthancUrl" -ForegroundColor Gray
Write-Host ""

# Test Orthanc connection
Write-Host "Testing Orthanc connection..." -ForegroundColor Yellow
try {
    $system = Invoke-RestMethod -Uri "$OrthancUrl/system" -TimeoutSec 5
    Write-Host "  ✓ Connected to Orthanc v$($system.Version)" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Cannot connect to Orthanc at $OrthancUrl" -ForegroundColor Red
    Write-Host "    Make sure Orthanc is running" -ForegroundColor Gray
    exit 1
}

Write-Host ""
Write-Host "Scanning for DICOM files..." -ForegroundColor Yellow

# Get all files recursively
$allFiles = Get-ChildItem -Path $Path -Recurse -File -ErrorAction SilentlyContinue

$dicomFiles = @()
$scannedCount = 0

foreach ($file in $allFiles) {
    $scannedCount++
    
    # Check if it's a DICOM file (has DICM magic bytes at offset 128)
    try {
        $stream = [System.IO.File]::OpenRead($file.FullName)
        if ($stream.Length -gt 132) {
            $buffer = New-Object byte[] 4
            $stream.Seek(128, [System.IO.SeekOrigin]::Begin) | Out-Null
            $stream.Read($buffer, 0, 4) | Out-Null
            $magic = [System.Text.Encoding]::ASCII.GetString($buffer)
            
            if ($magic -eq "DICM") {
                $dicomFiles += $file
            }
        }
        $stream.Close()
    } catch {
        # Skip unreadable files
    }
    
    # Progress indicator
    if ($scannedCount % 100 -eq 0) {
        Write-Host "  Scanned $scannedCount files, found $($dicomFiles.Count) DICOM..." -ForegroundColor Gray
    }
}

Write-Host "  Found $($dicomFiles.Count) DICOM files in $scannedCount total files" -ForegroundColor Green
Write-Host ""

if ($dicomFiles.Count -eq 0) {
    Write-Host "No DICOM files found in $Path" -ForegroundColor Yellow
    exit 0
}

# Upload files
Write-Host "Uploading to Orthanc..." -ForegroundColor Yellow
Write-Host ""

$total = $dicomFiles.Count
$success = 0
$failed = 0
$startTime = Get-Date

for ($i = 0; $i -lt $dicomFiles.Count; $i++) {
    $file = $dicomFiles[$i]
    $percent = [math]::Round(($i / $total) * 100)
    
    try {
        $fileBytes = [System.IO.File]::ReadAllBytes($file.FullName)
        
        $response = Invoke-WebRequest -Uri "$OrthancUrl/instances" `
            -Method POST `
            -ContentType "application/dicom" `
            -Body $fileBytes `
            -ErrorAction Stop
        
        if ($response.StatusCode -eq 200) {
            $success++
            if ($Verbose) {
                Write-Host "  ✓ $($file.Name)" -ForegroundColor Green
            }
        }
    } catch {
        $failed++
        if ($Verbose) {
            Write-Host "  ✗ $($file.Name): $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    
    # Progress bar (update every 10 files or at the end)
    if (($i % 10 -eq 0) -or ($i -eq $total - 1)) {
        $elapsed = (Get-Date) - $startTime
        $rate = if ($elapsed.TotalSeconds -gt 0) { [math]::Round($i / $elapsed.TotalSeconds, 1) } else { 0 }
        
        Write-Progress -Activity "Uploading DICOM files" `
            -Status "$percent% Complete ($($i+1)/$total) - $rate files/sec" `
            -PercentComplete $percent
    }
}

Write-Progress -Activity "Uploading DICOM files" -Completed

$elapsed = (Get-Date) - $startTime

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Upload Complete" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Successful: $success" -ForegroundColor Green
Write-Host "  Failed:     $failed" -ForegroundColor $(if ($failed -gt 0) { "Red" } else { "Gray" })
Write-Host "  Total:      $total" -ForegroundColor White
Write-Host "  Duration:   $([math]::Round($elapsed.TotalSeconds, 1)) seconds" -ForegroundColor Gray
Write-Host ""

# Show study count
try {
    $studies = Invoke-RestMethod -Uri "$OrthancUrl/studies"
    Write-Host "Studies now in Orthanc: $($studies.Count)" -ForegroundColor Cyan
} catch {
    # Ignore errors
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. View in Orthanc:  http://localhost:8042" -ForegroundColor Gray
Write-Host "  2. View in OHIF:     http://localhost:3000" -ForegroundColor Gray
Write-Host ""
