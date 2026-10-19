@echo off
rem Engram launcher for Windows: same job as bin/engram. Uses your Node.js 22+ if there is one, otherwise
rem fetches the official Node.js build once (checksum-verified) into %USERPROFILE%\.engram.
setlocal
set "DIR=%~dp0.."
set "ENGRAM_WASM_DIR=%DIR%\dist"
if defined ENGRAM_HOME (set "EH=%ENGRAM_HOME%") else (set "EH=%USERPROFILE%\.engram")
set "NODE=%ENGRAM_NODE%"
if not defined NODE if exist "%EH%\node-v22.23.1\node.exe" set "NODE=%EH%\node-v22.23.1\node.exe"
if not defined NODE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if defined NODE ( "%NODE%" -e "process.exit(+process.versions.node.split('.')[0]<22?1:0)" >nul 2>&1 || set "NODE=" )
if not defined NODE (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fetch-node.ps1" "%EH%" || exit /b 1
  set "NODE=%EH%\node-v22.23.1\node.exe"
)
"%NODE%" --liftoff-only "%DIR%\dist\engram.mjs" %*
