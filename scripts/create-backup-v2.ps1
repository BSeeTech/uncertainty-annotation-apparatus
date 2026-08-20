<#
.SYNOPSIS
    Create minimal compressed 7z backup of Medical Imaging Platform.
    Restorable via: docker compose up && cd ohif-viewer && yarn install

.DESCRIPTION
    Uses exclusion list from backup-exclude.txt to skip node_modules, .git,
    tmp/Task09_Spleen.tar, caches, binaries, and other non-essentials.
#>

$ErrorActionPreference = 'Stop'

# ── Project root ──────────────────────────────────────────────────────────
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

# ── 7-Zip path ────────────────────────────────────────────────────────────
$7z = "C:\Program Files\7-Zip\7z.exe"
if (-not (Test-Path $7z)) { $7z = (Get-Command 7z -ErrorAction SilentlyContinue).Source }
if (-not $7z) { Write-Error "7-Zip not found"; exit 1 }

# ── Exclude file ──────────────────────────────────────────────────────────
$exclude = "$scriptDir\backup-exclude.txt"
if (-not (Test-Path $exclude)) { Write-Error "Missing $exclude"; exit 1 }

# ── Timestamped archive name ──────────────────────────────────────────────
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$archive = Join-Path $projectRoot "mip-backup-$ts.7z"

Write-Host "`n=== MIP Backup ===" -ForegroundColor Cyan
Write-Host " Root  : $projectRoot"
Write-Host " Dest  : $archive"
Write-Host " Excl  : $exclude"
Write-Host " 7z    : $7z`n"

# ── Run 7z ────────────────────────────────────────────────────────────────
Write-Host "[...] Archiving (this may take a few minutes)..." -ForegroundColor Gray

& $7z a -t7z -mx=9 -mfb=273 -ms=on -md=64m -mmt=on "-x@$exclude" $archive "$projectRoot\*"

if ($LASTEXITCODE -ne 0) {
    Write-Error "7z failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

if ($proc.ExitCode -ne 0) {
    Write-Error "7z failed with exit code $($proc.ExitCode)"
    exit $proc.ExitCode
}

$size = [math]::Round((Get-Item $archive).Length / 1MB, 2)
Write-Host "`n✓ Done: $archive ($size MB)" -ForegroundColor Green
Write-Host ""
Write-Host "Restore:" -ForegroundColor Yellow
Write-Host "  7z x `"$archive`" -o<target-dir>"
Write-Host "  cd <target-dir>"
Write-Host "  copy .env.example .env"
Write-Host "  docker compose up -d"
Write-Host "  cd ohif-viewer && yarn install && yarn dev"
