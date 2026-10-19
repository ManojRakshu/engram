@echo off
set "OUT=%PROBE_OUT%"
if not defined OUT set "OUT=%TEMP%\probe-out"
if not exist "%OUT%" mkdir "%OUT%"
more > "%OUT%\%1-cmd.json"
