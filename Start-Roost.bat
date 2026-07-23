@echo off
REM ===== Roost launcher (Node.js / Windows) =====
REM Zero dependencies - no install step. Just double-click this file:
REM it starts the server and opens Roost in your browser.

cd /d "%~dp0"
echo.
echo   Roost - commission ^& residual intelligence
echo   ==========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo   Node.js was not found on your PATH.
  echo   Install the LTS build from https://nodejs.org/ then run this again.
  echo.
  pause
  exit /b 1
)

echo   Starting Roost at http://127.0.0.1:5000
echo   Close this window to stop Roost.
echo.
start "" http://127.0.0.1:5000
node server.js
pause
