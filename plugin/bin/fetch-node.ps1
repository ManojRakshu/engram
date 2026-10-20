# Fetch the official Node.js build for Windows once, checksum-verified, into <ENGRAM_HOME>\node-<version>.
param([string]$EH = (Join-Path $HOME ".engram"))
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
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
    try { (New-Object Net.WebClient).DownloadFile("https://nodejs.org/dist/$Ver/$Name.zip", $zip); break }
    catch { if ($i -eq 3) { throw }; Start-Sleep 2 }
  }
  $sums = (New-Object Net.WebClient).DownloadString("https://nodejs.org/dist/$Ver/SHASUMS256.txt")
  $want = ($sums -split "`n" | Where-Object { $_ -match " $Name\.zip$" }) -replace " .*", ""
  # .NET directly: no dependency on PowerShell modules (Get-FileHash/Expand-Archive), which break when
  # Windows PowerShell is started from PowerShell 7 with its module path.
  $fs = [IO.File]::OpenRead($zip)
  try { $got = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($fs) | ForEach-Object { $_.ToString("x2") }) } finally { $fs.Close() }
  if (-not $want -or $got -ne $want.Trim()) { throw "checksum mismatch for $Name.zip" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $Tmp)
  Remove-Item -Recurse -Force $Final -ErrorAction SilentlyContinue
  Move-Item (Join-Path $Tmp $Name) $Final
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
