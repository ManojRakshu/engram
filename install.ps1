# Engram installer for Windows. Needs nothing preinstalled (no Docker, no WSL, no Node, no database):
#   irm https://raw.githubusercontent.com/ManojRakshu/engram/main/install.ps1 | iex
# Setup flags: & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ManojRakshu/engram/main/install.ps1))) --agents cursor,codex
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # Invoke-WebRequest is many times slower with the progress bar
$Repo = if ($env:ENGRAM_REPO) { $env:ENGRAM_REPO } else { "https://github.com/ManojRakshu/engram" }
$EH = if ($env:ENGRAM_HOME) { $env:ENGRAM_HOME } else { Join-Path $HOME ".engram" }
$Dest = Join-Path $EH "app"
New-Item -ItemType Directory -Force $EH | Out-Null

if (Test-Path (Join-Path $Dest ".git")) {
  git -C $Dest pull -q --ff-only
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  git -c core.autocrlf=false clone -q --depth 1 $Repo $Dest
} else {
  $zip = Join-Path $EH "app.zip"
  Invoke-WebRequest "$Repo/archive/refs/heads/main.zip" -OutFile $zip
  $tmp = Join-Path $EH "app.tmp"
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Expand-Archive $zip $tmp
  Remove-Item -Recurse -Force $Dest -ErrorAction SilentlyContinue
  Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $Dest
  Remove-Item -Recurse -Force $tmp, $zip
}

# An `engram` command: a small shim in ~/.engram/bin, which goes on your user PATH.
$Bin = Join-Path $EH "bin"
New-Item -ItemType Directory -Force $Bin | Out-Null
Set-Content -Encoding ascii (Join-Path $Bin "engram.cmd") "@`"$Dest\plugin\bin\engram.cmd`" %*"
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($UserPath -split ";") -contains $Bin)) {
  [Environment]::SetEnvironmentVariable("Path", ((@($UserPath, $Bin) | Where-Object { $_ }) -join ";"), "User")
  Write-Host "  added $Bin to your user PATH (new terminals pick it up)"
}
$env:Path = "$Bin;$env:Path"

& (Join-Path $Dest "plugin\bin\engram.cmd") setup @args
