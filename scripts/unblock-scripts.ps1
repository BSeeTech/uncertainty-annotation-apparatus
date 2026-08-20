# Unblock PowerShell Scripts
# Place at: C:\medical-imaging-platform\scripts\unblock-scripts.ps1
# Run this ONCE to allow scripts to execute without security warnings

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Unblocking PowerShell Scripts" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Check current execution policy
$currentPolicy = Get-ExecutionPolicy -Scope CurrentUser
Write-Host "Current Execution Policy: $currentPolicy" -ForegroundColor Yellow
Write-Host ""

# Unblock all PowerShell scripts in the scripts directory
Write-Host "Unblocking scripts in .\scripts\ directory..." -ForegroundColor Yellow

try {
    $scripts = Get-ChildItem -Path ".\scripts\*.ps1" -ErrorAction Stop
    
    if ($scripts.Count -eq 0) {
        Write-Host "No PowerShell scripts found in .\scripts\ directory" -ForegroundColor Red
        exit 1
    }
    
    Write-Host "Found $($scripts.Count) script(s):" -ForegroundColor Gray
    foreach ($script in $scripts) {
        Write-Host "  - $($script.Name)" -ForegroundColor Gray
    }
    Write-Host ""
    
    # Unblock each script
    foreach ($script in $scripts) {
        Unblock-File -Path $script.FullName
        Write-Host "  ✓ Unblocked: $($script.Name)" -ForegroundColor Green
    }
    
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "All scripts unblocked successfully!" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
    
    # Check if execution policy needs to be changed
    if ($currentPolicy -eq "Restricted" -or $currentPolicy -eq "AllSigned") {
        Write-Host "RECOMMENDATION:" -ForegroundColor Yellow
        Write-Host "Your execution policy is '$currentPolicy'" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "To avoid future issues, consider changing it to 'RemoteSigned':" -ForegroundColor White
        Write-Host "  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser" -ForegroundColor Cyan
        Write-Host ""
    } else {
        Write-Host "Execution policy is set to: $currentPolicy" -ForegroundColor Green
        Write-Host "This should allow scripts to run without issues." -ForegroundColor Green
        Write-Host ""
    }
    
    Write-Host "You can now run scripts without security warnings!" -ForegroundColor White
    Write-Host "Try: .\scripts\start.ps1" -ForegroundColor Cyan
    Write-Host ""
    
} catch {
    Write-Host "ERROR: Failed to unblock scripts" -ForegroundColor Red
    Write-Host "Details: $($_.Exception.Message)" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Make sure you're running this from:" -ForegroundColor Yellow
    Write-Host "  C:\medical-imaging-platform\" -ForegroundColor Cyan
    Write-Host ""
    exit 1
}
