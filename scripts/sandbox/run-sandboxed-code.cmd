@echo off
rem ============================================================================
rem Sandbox: run this repo's Extension Development Host in a PATH that has no pi.
rem
rem Usage (from repo root):
rem   scripts\sandbox\run-sandboxed-code.cmd            mode 1: node present, pi absent
rem   scripts\sandbox\run-sandboxed-code.cmd fresh      mode 1 + EMPTY home (true first install)
rem   scriptssandboxun-sandboxed-code.cmd install [keep]  WIPE state, install vsix, open window
rem                                                          (keep = reuse previous state)
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
rem "fresh" mode additionally isolates the pi agent dir (~/.pi/agent = auth.json
rem + sessions) by pointing USERPROFILE at an empty temp home, and gives VS Code
rem a throwaway --user-data-dir, so the panel behaves like a first install:
rem empty session list, no credentials, first-run credential prompt.
rem NOTE: pi resolves its agent dir with os.homedir(), i.e. USERPROFILE on Windows.
rem Keep every comment ASCII: cmd in codepage 936 mis-parses UTF-8 Chinese here
rem and would try to execute the mangled fragments.
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
rem Second arg "keep" = do NOT wipe. Default is WIPE: every test run must start clean
rem (credentials/sessions/settings from the previous run otherwise leak in).
set "KEEP="
if /i "%~2"=="keep" set "KEEP=1"

rem Stop a running sandbox instance BEFORE touching its dirs: wiping user-data under a
rem live window leaves a half-dead profile and the next launch behaves weird.
if defined PROBE goto :nowipe
if defined KEEP goto :nowipe
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-sandbox.ps1"
ping -n 4 127.0.0.1 >nul
if exist "%SBROOT%\home\.pi" rd /s /q "%SBROOT%\home\.pi" 2>nul
if exist "%SBROOT%\vscode-user-data" rd /s /q "%SBROOT%\vscode-user-data" 2>nul
echo [sandbox] state wiped (home/.pi + vscode-user-data)
:nowipe

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

rem fresh mode: isolate pi's agent dir (auth.json + sessions) with an empty home.
rem pi uses os.homedir(); on Windows that is USERPROFILE. APPDATA is left alone so
rem VS Code itself keeps functioning (--user-data-dir is passed separately).
set "USERDATA_ARG="
set "EXTDIR_ARG="
set "FRESH="
if /i "%MODE%"=="fresh" set "FRESH=1"
if /i "%MODE%"=="install" set "FRESH=1"
if not defined FRESH goto :launch
set "SANDBOXHOME=%SBROOT%\home"
if not exist "%SANDBOXHOME%" mkdir "%SANDBOXHOME%" >nul 2>&1
set "USERPROFILE=%SANDBOXHOME%"
set "HOME=%SANDBOXHOME%"
set "USERDATA_ARG=--user-data-dir=%SBROOT%\vscode-user-data"
set "EXTDIR_ARG=--extensions-dir=%SBROOT%\vscode-extensions"
echo [sandbox] USERPROFILE=%USERPROFILE%
if exist "%SANDBOXHOME%\.pi\agent\auth.json" echo [sandbox] WARNING: sandbox home still has auth.json
echo [sandbox] ~/.pi/agent =
if exist "%SANDBOXHOME%\.pi\agent" (echo     exists) else (echo     absent - fresh user)
echo.

:launch
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

if /i "%MODE%"=="install" (
  set "VSIX=%~2"
  if not defined VSIX (
    for /f "delims=" %%i in ('dir /b /o-d "%~dp0..\..\*.vsix" 2^>nul') do if not defined VSIX set "VSIX=%~dp0..\..\%%i"
  )
  if not defined VSIX (
    echo [sandbox] install mode: no vsix found, run "npm run release" first
    endlocal
    exit /b 1
  )
  echo [sandbox] installing: !VSIX!
  call "%CODEBIN%" %USERDATA_ARG% %EXTDIR_ARG% --install-extension "!VSIX!" --force
  if errorlevel 1 (
    echo [sandbox] install failed
    endlocal
    exit /b 1
  )
)

rem A fresh profile + untrusted workspace puts VS Code in Restricted Mode, which
rem disables third-party extensions (they never activate) - so the sandbox launch
rem must turn workspace trust off: --disable-workspace-trust.
rem Other flags: skip release notes / welcome to reduce noise.
set "SANDBOXFLAGS=--disable-workspace-trust --disable-telemetry --skip-release-notes --skip-welcome"

echo [sandbox] launching: %CODEBIN%
call "%CODEBIN%" --new-window %USERDATA_ARG% %EXTDIR_ARG% %SANDBOXFLAGS% "%~dp0..\.."
endlocal