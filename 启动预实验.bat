@echo off
chcp 65001 >nul
title Pilot Experiment Server (LAN)
cd /d "%~dp0"

rem This file is intentionally pure ASCII: cmd.exe parses .bat with the system
rem code page, and Chinese text here would be mis-split after chcp 65001.
rem All Chinese messages live in scripts\pilot-start.js instead.
set "NODE_EXE=%~dp0node.exe"
if exist "%NODE_EXE%" goto run

where node >nul 2>nul
if errorlevel 1 goto nonode
set "NODE_EXE=node"

:run
"%NODE_EXE%" "%~dp0scripts\pilot-start.js"
echo.
pause
exit /b 0

:nonode
echo.
echo  [!] Node.js runtime not found.
echo      Please make sure the whole folder was fully extracted and no file was moved.
echo      Or install Node.js 22 or newer from https://nodejs.org/ and run this file again.
echo.
pause
exit /b 1
