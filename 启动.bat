@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  node server\main.js
  goto :done
)
if exist "%ProgramFiles%\nodejs\node.exe" (
  "%ProgramFiles%\nodejs\node.exe" server\main.js
  goto :done
)
echo.
echo [TishenTai] Node.js not found. Please install Node.js (LTS) first.
echo.
:done
echo.
pause
