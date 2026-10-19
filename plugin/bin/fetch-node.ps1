# Fetch the official Node.js build for Windows once, checksum-verified, into <ENGRAM_HOME>\node-<version>.
param([string]$EH = (Join-Path $HOME ".engram"))
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Ver = "v22.23.1"
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$Name = "node-$Ver-win-$Arch"
$Final = Join-Path $EH "node-$Ver"
if (Test-Path (Join-Path $Final "node.exe")) { exit 0 }
[Console]::Error.WriteLine("engram: fetching Node.js $Ver (one time)...")
$Tmp = Join-Path $EH ".node-download-$PID"
New-Item -ItemType Directory -Force $Tmp | Out-Null
try {
  $zip = Join-Path $Tmp "$Name.zip"
  foreach ($i in 1..3) {
    try { Invoke-WebRequest "https://nodejs.org/dist/$Ver/$Name.zip" -OutFile $zip -TimeoutSec 120; break }
    catch { if ($i -eq 3) { throw }; Start-Sleep 2 }
  }
  $sums = (Invoke-WebRequest "https://nodejs.org/dist/$Ver/SHASUMS256.txt" -UseBasicParsing).Content
  $want = ($sums -split "`n" | Where-Object { $_ -match " $Name\.zip$" }) -replace " .*", ""
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $got -ne $want.Trim()) { throw "checksum mismatch for $Name.zip" }
  Expand-Archive $zip $Tmp
  Remove-Item -Recurse -Force $Final -ErrorAction SilentlyContinue
  Move-Item (Join-Path $Tmp $Name) $Final
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
