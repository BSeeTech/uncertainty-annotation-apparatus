<#
.SYNOPSIS
    Create a minimal, maximum-compression 7z backup of the Medical Imaging Platform
    that can be restored and run with `docker compose up` and `yarn install`.

.DESCRIPTION
    Excludes node_modules/, .git/, tmp/Task09_Spleen.tar (1.6GB), .reasonix/attachments/,
    .codex/, .agents/, Python caches, binary documents (docx/pdf/jpg/png), and other
    non-essential files to achieve the smallest possible archive size.

    Output: medical-imaging-platform-backup-YYYYMMDD-HHMMSS.7z
    Location: parent directory of $PSScriptRoot (i.e. ..\ relative to this script)

.PARAMETER OutputDir
    Directory where the .7z file will be saved. Defaults to the parent of the project root.

.PARAMETER NoDelete
    If set, does NOT delete the temporary exclusion list file after completion.

.EXAMPLE
    # Run from any directory (script auto-detects project root)
    .\scripts\create-backup.ps1

.EXAMPLE
    # Save backup to a specific drive
    .\scripts\create-backup.ps1 -OutputDir D:\backups
#>

param(
    [string]$OutputDir = (Resolve-Path "$PSScriptRoot\..\.." -ErrorAction Stop),
    [switch]$NoDelete
)

$ErrorActionPreference = 'Stop'

# ── 1. Locate project root (where docker-compose.yml lives) ──────────────
$projectRoot = Resolve-Path "$PSScriptRoot\.." -ErrorAction Stop
if (-not (Test-Path "$projectRoot\docker-compose.yml")) {
    Write-Error "Could not find docker-compose.yml in $projectRoot — are you running from the right place?"
    exit 1
}

# ── 2. Verify 7-Zip is available ──────────────────────────────────────────
$7zPath = "C:\Program Files\7-Zip\7z.exe"
if (-not (Test-Path $7zPath)) {
    # Fallback: try PATH
    $7zPath = (Get-Command 7z -ErrorAction SilentlyContinue).Source
    if (-not $7zPath) {
        Write-Error "7-Zip not found at '$7zPath' or in PATH. Please install 7-Zip (https://7-zip.org)"
        exit 1
    }
}
Write-Host "[✓] Using 7-Zip: $7zPath"

# ── 3. Build the exclusion list ──────────────────────────────────────────
$excludeFile = "$env:TEMP\mip-backup-exclude.txt"

@"
tmp\Task09_Spleen.tar
.git\
.git\*
node_modules\
node_modules\*
.reasonix\attachments\
.reasonix\attachments\*
.codex\
.codex\*
.agents\
.agents\*
.understand-anything\
.understand-anything\*
__pycache__\
__pycache__\*
*.pyc
.pytest_cache\
.pytest_cache\*
.eggs\
*.egg-info\
venv\
.venv\
*.docx
*.pdf
*.jpg
*.jpeg
*.png
*.gif
*.ico
.idea\
.vscode\
*.swp
*.swo
Thumbs.db
.DS_Store
.docker\
logs\
coverage\
.nyc_output\
dist\
build\
.next\
out\
*.log
"@ | Set-Content -Path $excludeFile -Encoding ASCII

Write-Host "[✓] Exclusion list built"

# ── 4. Build archive filename ────────────────────────────────────────────
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveName = "medical-imaging-platform-backup-$timestamp.7z"
$archivePath = Join-Path $OutputDir $archiveName

Write-Host ""
Write-Host "=============================================="
Write-Host " Project root : $projectRoot"
Write-Host " Archive      : $archivePath"
Write-Host " Exclude file : $excludeFile"
Write-Host "=============================================="
Write-Host ""

# ── 5. Run 7z with maximum compression (mx=9) ───────────────────────────
#    Flags:
#      a        = add to archive
#      -t7z     = 7z format
#      -mx=9    = ultra compression
#      -mfb=273 = max fast bytes for LZMA2
#      -ms=on   = solid archive (better ratio for many small files)
#      -md=64m  = 64 MB dictionary (good balance size/speed)
#      -mmt=on  = multi-threaded
#      -x@...   = read exclusion patterns from file
#      -xr!...  = additional exclusion patterns
Write-Host "[...] Creating archive (this may take a few minutes)..." -NoNewline

$arguments = @(
    "a"
    "-t7z"
    "-mx=9"
    "-mfb=273"
    "-ms=on"
    "-md=64m"
    "-mmt=on"
    "-x@`"$excludeFile`""
    "-xr!node_modules"
    "-xr!.git"
    "-xr!tmp\Task09_Spleen.tar"
    "-xr!.reasonix\attachments"
    "-xr!__pycache__"
    "-xr!*.pyc"
    "-xr!.pytest_cache"
    "-xr!*.docx"
    "-xr!*.pdf"
    "-xr!*.jpg"
    "-xr!*.jpeg"
    "-xr!*.png"
    "-xr!*.ico"
    "-xr!.gitignore"    # keep .gitignore, don't exclude it — oops, need to keep gitignore
    "`"$archivePath`""
    "`"$projectRoot\*`""
)

# Actually, let's use a simpler approach with Start-Process for proper quoting
$argList = @(
    "a"
    "-t7z"
    "-mx=9"
    "-mfb=273"
    "-ms=on"
    "-md=64m"
    "-mmt=on"
    "`"$archivePath`""
    "`"$projectRoot\*`""
    "-xr!node_modules"
    "-xr!.git"
    "-xr@`"$excludeFile`""
)

$proc = Start-Process -FilePath $7zPath `
    -ArgumentList $argList `
    -NoNewWindow -Wait -PassThru

if ($proc.ExitCode -eq 0) {
    Write-Host " [DONE]"
} else {
    Write-Host " [FAILED - exit code $($proc.ExitCode)]"
    if (-not $NoDelete) { Remove-Item $excludeFile -ErrorAction SilentlyContinue }
    exit $proc.ExitCode
}

# ── 6. Show result ────────────────────────────────────────────────────────
$fileInfo = Get-Item $archivePath
$sizeMB = [math]::Round($fileInfo.Length / 1MB, 2)

Write-Host ""
Write-Host "══════════════════════════════════════════"
Write-Host " ✓ Backup created successfully!"
Write-Host "   File : $archiveName"
Write-Host "   Size : $sizeMB MB"
Write-Host "   Path : $archivePath"
Write-Host "══════════════════════════════════════════"
Write-Host ""
Write-Host "To restore:"
Write-Host "  1. Extract: 7z x `"$archiveName`" -o<target-dir>"
Write-Host "  2. cd <target-dir>"
Write-Host "  3. Copy .env.example to .env and edit if needed"
Write-Host "  4. docker compose up -d"
Write-Host "  5. cd ohif-viewer && yarn install && yarn dev"
Write-Host ""

# ── 7. Cleanup ────────────────────────────────────────────────────────────
if (-not $NoDelete) {
    Remove-Item $excludeFile -ErrorAction SilentlyContinue
    Write-Host "[✓] Temp files cleaned up"
}
