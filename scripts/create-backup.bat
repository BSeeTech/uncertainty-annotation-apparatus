@echo off
REM ============================================================
REM  MIP Backup — run from project root in cmd.exe
REM  Creates minimal 7z backup restorable via:
REM    docker compose up && cd ohif-viewer && yarn install
REM ============================================================

for %%I in ("%~dp0..") do set "PROJECT=%%~fI"
set "SEVENZ=C:\Program Files\7-Zip\7z.exe"

if not exist "%SEVENZ%" (
    echo [ERROR] 7-Zip not found
    pause & exit /b 1
)

set "TS=%DATE:/=%"
set "TS=%TS:-=%"
set "TS=%TS: =%"
set "ARCHIVE=%PROJECT%\mip-backup-%TS%.7z"

echo.
echo === MIP Backup ===
echo Root  : %PROJECT%
echo Dest  : %ARCHIVE%
echo 7z    : %SEVENZ%
echo.

REM Build the full 7z command with all -xr! exclusions
set "ARGS=a -t7z -mx=9 -mfb=273 -ms=on -md=64m -mmt=on"
set "ARGS=%ARGS% -xr!.git"
set "ARGS=%ARGS% -xr!node_modules"
set "ARGS=%ARGS% -xr!tmp\Task09_Spleen.tar"
set "ARGS=%ARGS% -xr!.reasonix\attachments"
set "ARGS=%ARGS% -xr!.codex"
set "ARGS=%ARGS% -xr!.agents"
set "ARGS=%ARGS% -xr!.understand-anything"
set "ARGS=%ARGS% -xr!__pycache__"
set "ARGS=%ARGS% -xr!*.pyc"
set "ARGS=%ARGS% -xr!.pytest_cache"
set "ARGS=%ARGS% -xr!.eggs"
set "ARGS=%ARGS% -xr!*.egg-info"
set "ARGS=%ARGS% -xr!venv"
set "ARGS=%ARGS% -xr!.venv"
set "ARGS=%ARGS% -xr!*.docx"
set "ARGS=%ARGS% -xr!*.pdf"
set "ARGS=%ARGS% -xr!*.jpg"
set "ARGS=%ARGS% -xr!*.jpeg"
set "ARGS=%ARGS% -xr!*.png"
set "ARGS=%ARGS% -xr!*.ico"
set "ARGS=%ARGS% -xr!.vscode"
set "ARGS=%ARGS% -xr!.idea"
set "ARGS=%ARGS% -xr!Thumbs.db"
set "ARGS=%ARGS% -xr!.DS_Store"
set "ARGS=%ARGS% -xr!dist"
set "ARGS=%ARGS% -xr!build"
set "ARGS=%ARGS% -xr!.next"
set "ARGS=%ARGS% -xr!out"
set "ARGS=%ARGS% -xr!coverage"
set "ARGS=%ARGS% -xr!.nyc_output"
set "ARGS=%ARGS% -xr!logs"
set "ARGS=%ARGS% -xr!*.7z"
set "ARGS=%ARGS% -xr!data\orthanc-data"
set "ARGS=%ARGS% -xr!data\monai-data"
set "ARGS=%ARGS% -xr!evaluation\ct-spleen\data"

"%SEVENZ%" %ARGS% "%ARCHIVE%" "%PROJECT%\*"

if errorlevel 1 (
    echo [ERROR] 7z failed with exit code %ERRORLEVEL%
    pause & exit /b %ERRORLEVEL%
)

for %%F in ("%ARCHIVE%") do set SIZE=%%~zF
set /a SIZE=%SIZE%/1048576

echo.
echo ============================================
echo  SUCCESS!  %ARCHIVE%
echo  Size: %SIZE% MB
echo ============================================
echo.
echo To restore:
echo   7z x "%PROJECT%\mip-backup-%TS%.7z" -o^<target^>
echo   cd ^<target^>
echo   copy .env.example .env
echo   docker compose up -d
echo   cd ohif-viewer ^&^& yarn install ^&^& yarn dev
echo.

pause
