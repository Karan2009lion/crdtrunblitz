@echo off
rem Starts the CRDTrade paper bot by itself whenever you sign in to Windows, so a restart
rem (for example after a Windows update) doesn't end a 10-day test.
rem   autostart.bat         turn on
rem   autostart.bat --off   turn off
setlocal
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CRDTrade paper bot.bat"

if "%~1"=="--off" (
  del "%LINK%" 2>nul
  echo CRDTrade will no longer start when you sign in.
  pause
  exit /b 0
)

echo @echo off> "%LINK%"
echo cd /d "%~dp0.">> "%LINK%"
echo call start.bat>> "%LINK%"

echo Done. CRDTrade will start by itself each time you sign in to Windows,
echo and the bot carries on with the same paper test.
echo To turn this off, run: autostart.bat --off
pause
