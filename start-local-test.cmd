@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ==================================================
echo   Otzaria Community Notes - Local Test Launcher
echo ==================================================
echo.
echo [1/3] Preparing local dev plugin folder (dist\dev-plugin)...
call npm run pack:dev
if errorlevel 1 (
  echo Failed to build dev plugin.
  pause
  exit /b 1
)

echo.
echo [2/3] Starting local test server on http://127.0.0.1:8787 ...
start "Otzaria Community Notes - Local Server" cmd /k "cd /d ""%~dp0"" && node scripts\dev-worker-local.mjs"
timeout /t 2 /nobreak >nul

echo.
echo [3/3] Launching Otzaria in developer plugin mode (--dev-plugins)...
echo Note: Close any already-running Otzaria window before continuing if dev buttons do not appear.
if exist "C:\Program Files\otzaria\otzaria.exe" (
  start "" "C:\Program Files\otzaria\otzaria.exe" --dev-plugins
) else if exist "C:\Program Files\Otzaria\otzaria.exe" (
  start "" "C:\Program Files\Otzaria\otzaria.exe" --dev-plugins
) else (
  echo Could not find otzaria.exe in Program Files. Start Otzaria manually with --dev-plugins.
)

echo.
echo ==================================================
echo   Next steps inside Otzaria:
echo   1. Go to "כלים" -> "תוספים" (puzzle icon)
echo   2. Click the folder icon at the top ("טעינה מתיקייה")
echo   3. Select: %~dp0dist\dev-plugin
echo   4. Approve permissions
echo   5. Test registration with:
echo      - Moderator invite: OTZ-MOD-2026
echo      - Regular beta invite: OTZ-BETA-2026
echo ==================================================
pause
