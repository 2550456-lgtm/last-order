@echo off
rem ============================================================================
rem  Hackathon Team Radar - Windows launcher (double-click me)
rem
rem  This file is deliberately ASCII-only.
rem  Reason: cmd.exe reads a .bat by byte offset using the *current* codepage.
rem  Putting `chcp 65001` in here and Chinese text after it makes cmd lose its
rem  place and start executing fragments of lines as commands. Keeping this file
rem  ASCII avoids the whole class of problems. All Chinese output comes from
rem  server.js, which sets the console codepage itself before printing.
rem ============================================================================

setlocal
title Hackathon Team Radar
cd /d "%~dp0"

echo.
echo   Hackathon Team Radar
echo   ---------------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

for /f "delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 goto OLD_NODE

echo   Node.js v%NODE_MAJOR% detected. Starting...
echo   Browser will open automatically.
echo   Close this window or press Ctrl+C to stop.
echo.

node server.js --open
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" (
  echo   Server exited with code %EXITCODE%. Please screenshot the messages above.
) else (
  echo   Server stopped normally.
)
echo.
pause
exit /b %EXITCODE%

:NO_NODE
echo   [x] Node.js not found.
echo.
echo   This app needs Node.js 18 or newer.
echo   Install the LTS build from https://nodejs.org (click Next all the way),
echo   then double-click this file again.
echo.
echo   ---- No Node.js? There is a fallback ----
echo   Upload the "public" folder to any static host (GitHub Pages / Vercel)
echo   and open it with ?offline=1 appended to the URL. Card generation,
echo   PNG export, share links and local matching all still work; only the
echo   cross-device sync is unavailable.
echo.
pause
exit /b 1

:OLD_NODE
echo   [x] Node.js is too old: v%NODE_MAJOR% found, v18+ required.
echo.
echo   Please install the latest LTS from https://nodejs.org
echo.
pause
exit /b 1
