@echo off
rem ============================================================================
rem Sandbox: run this repo's Extension Development Host in a PATH that has no pi.
rem
rem Usage (from repo root):
rem   scripts\sandbox\run-sandboxed-code.cmd            mode 1: node present, pi absent
rem   scripts\sandbox\run-sandboxed-code.cmd no-node    mode 2: neither node nor pi
rem   scripts\sandbox\run-sandboxed-code.cmd probe       only prepare + print, no VS Code
rem
rem Why this works: on Windows pi and node usually live in the same directory
rem (C:\Program Files\nodejs\pi.cmd). Copying node.exe alone into a temp dir and
rem keeping only that dir + System32 on PATH makes pi disappear, while node stays.
rem Press F5 inside the window that opens: the extension dev host inherits this
rem PATH, so the panel sees the "no pi" world. Gear menu -> Subscription login
rem should then run "node + bundled vendor/pi/dist/bundle/cli.js", never PATH pi.
rem
rem Side effect: the integrated terminal in that window also gets the trimmed
rem PATH (that is the point) - do not run npm there.
rem ============================================================================
setlocal EnableDelayedExpansion
set "SBROOT=%TEMP%\pi-vscode-sandbox"
set "NODEDIR=%SBROOT%\node-only"
set "MODE=%~1"

set "SRCNODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined SRCNODE set "SRCNODE=%%i"

rem Resolve code.cmd BEFORE trimming PATH (after trimming it is no longer findable)
set "CODEBIN="
for /f "delims=" %%i in ('where code.cmd 2^>nul') do if not defined CODEBIN set "CODEBIN=%%i"
if not defined CODEBIN if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" set "CODEBIN=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"
if not defined CODEBIN if exist "%ProgramFiles%\Microsoft VS Code\bin\code.cmd" set "CODEBIN=%ProgramFiles%\Microsoft VS Code\bin\code.cmd"
if not defined CODEBIN (
  for /f "delims=" %%i in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Code.exe" /ve 2^>nul ^| findstr /i "Code.exe"') do set "CODEREG=%%i"
)
if not defined CODEBIN if defined CODEREG (
  for %%i in ("!CODEREG!") do set "CODEBIN=%%~dpi..\bin\code.cmd"
)

set "PROBE="
if /i "%MODE%"=="probe" set "PROBE=1"
if /i "%~2"=="probe" set "PROBE=1"

if /i "%MODE%"=="no-node" goto :setpath
if not exist "%NODEDIR%" mkdir "%NODEDIR%" >nul 2>&1
if not defined SRCNODE (
  echo [sandbox] no node on PATH - falling back to "neither" mode
  goto :setpath
)
if not exist "%NODEDIR%\node.exe" copy /y "%SRCNODE%" "%NODEDIR%\node.exe" >nul

:setpath
if /i "%MODE%"=="no-node" (
  set "PATH=%SystemRoot%\System32;%SystemRoot%"
) else (
  set "PATH=%NODEDIR%;%SystemRoot%\System32;%SystemRoot%"
)
echo [sandbox] mode=%MODE%
echo [sandbox] PATH=%PATH%
for /f "delims=" %%i in ('where node 2^>nul') do echo [sandbox] node -^> %%i
for /f "delims=" %%i in ('where pi 2^>nul') do echo [sandbox] pi   -^> %%i
echo.

if defined PROBE (
  echo [sandbox] probe mode done, VS Code not started
  endlocal
  exit /b 0
)

if not defined CODEBIN (
  echo [sandbox] code.cmd not found - start VS Code manually with the trimmed PATH above
  endlocal
  exit /b 1
)

echo [sandbox] launching: %CODEBIN%
call "%CODEBIN%" --new-window "%~dp0..\.."
endlocal