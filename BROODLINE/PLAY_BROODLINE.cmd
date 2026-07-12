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
start "" "http://127.0.0.1:8080"
node server.mjs
endlocal
