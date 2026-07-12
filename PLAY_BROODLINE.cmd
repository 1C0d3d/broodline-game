@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo BROODLINE needs Node.js to start its local game server.
  echo Install Node.js from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if not defined BROODLINE_PORT set "BROODLINE_PORT=8080"
start "BROODLINE LAN SERVER" /D "%~dp0" node server.mjs
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(8); do { try { $response=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:%BROODLINE_PORT%/broodline/health'; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 150 } while ((Get-Date) -lt $deadline); exit 1"
if errorlevel 1 (
  echo BROODLINE LAN could not start. Check the server window for details.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:%BROODLINE_PORT%"
endlocal
