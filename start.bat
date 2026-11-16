@echo off
rem Builds and starts the CRDTrade BTC paper bot on this computer (Windows).
rem   start.bat            build and start
rem   start.bat --update   download the latest version from GitHub first
setlocal
cd /d "%~dp0"
set PORT=4173
set URL=http://localhost:%PORT%

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org, then run start.bat again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)"
if errorlevel 1 (
  echo Your Node.js version is too old. Install Node.js 22 LTS from https://nodejs.org, then run start.bat again.
  pause
  exit /b 1
)

if "%~1"=="--update" (
  echo Downloading the latest version...
  git pull --ff-only || goto :fail
)

echo Installing...
call npm ci --no-audit --no-fund --loglevel=error || goto :fail
echo Building...
call npm run build --silent || goto :fail

echo.
echo CRDTrade is running at %URL%
echo Keep this window open during the test. Press Ctrl+C to stop the app.
echo.
start "" /b node scripts\open-when-ready.cjs %URL%
call node server\index.mjs
exit /b 0

:fail
echo Something went wrong. Read the message above, then run start.bat again.
pause
exit /b 1
