# Enigma Avatar - desktop overlay launcher (NO admin required).
# Runs the repo-local Electron DIRECTLY - Node is only needed for the ONE-TIME dependency
# install. (The old launcher hard-required portable Node at %LOCALAPPDATA%\node-portable;
# agent-side installs put that inside a virtualized MSIX store the real desktop session
# can't see, so the desktop shortcut died invisibly at the "Node not found" check.)
# Failures now pop a dialog instead of vanishing in the hidden window.
# NOTE: this file must stay pure ASCII - PowerShell 5.1 reads BOM-less files as ANSI, and
# a multi-byte dash decodes into a smart-quote that BREAKS PARSING (cost a debug cycle).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
function Fail($msg) {
  try { (New-Object -ComObject WScript.Shell).Popup("Enigma Avatar`n`n$msg", 0, "Enigma Avatar", 48) | Out-Null } catch {}
  Write-Error $msg; exit 1
}

$electron = Join-Path $PSScriptRoot "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) {
  # One-time install: find ANY usable npm (portable Node, repo tools, or PATH).
  $npm = $null
  foreach ($dir in @("$env:LOCALAPPDATA\node-portable", (Join-Path $PSScriptRoot "..\..\tools\node"))) {
    if (Test-Path (Join-Path $dir "npm.cmd")) { $npm = Join-Path $dir "npm.cmd"; $env:Path = "$dir;" + $env:Path; break }
  }
  if (-not $npm) { $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source }
  if (-not $npm) { Fail "First run needs Node.js to install Electron (one-time, ~200MB). Install Node, then double-click again." }
  Write-Host "Installing dependencies (electron + three + three-vrm; one-time, ~200MB)..." -ForegroundColor Cyan
  & $npm install
  if (-not (Test-Path $electron)) { Fail "Dependency install failed - run 'npm install' in $PSScriptRoot to see why." }
}

# Avatar bus - AI control (ws://127.0.0.1:8765). Best-effort: needs Python + websockets;
# the avatar works fine without it.
$bus = $null
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if ($python) {
  $bus = Start-Process -FilePath $python -ArgumentList "`"$PSScriptRoot\bus.py`"" -WindowStyle Hidden -PassThru
}

Write-Host "Launching Enigma Avatar overlay." -ForegroundColor Green
Write-Host "  Right-click the avatar for the menu (models, emotes, toggles)." -ForegroundColor DarkGray
Write-Host "  Ctrl+Alt+Q quit   Ctrl+Alt+A toggle click-through   Alt+drag rotate   H hide panel" -ForegroundColor DarkGray
try {
  # Electron directly (not npm) so its quit-reason / window-set diagnostics stream into the
  # log unbuffered. PS 5.1 wraps redirected native stderr in ErrorRecords and EAP=Stop would
  # treat the FIRST diagnostic line as fatal - relax while the overlay runs.
  $ErrorActionPreference = "Continue"
  $avatarLog = Join-Path $env:TEMP "enigma_avatar.log"
  & $electron . 2>&1 | Tee-Object -FilePath $avatarLog
  # A clean quit exits 0; an instant crash (GPU/DLL) used to vanish in the hidden window (audit).
  if ($LASTEXITCODE -ne 0) { Fail "The overlay exited with code $LASTEXITCODE - see $avatarLog" }
} finally {
  if ($bus -and -not $bus.HasExited) { Stop-Process -Id $bus.Id -Force -ErrorAction SilentlyContinue }
}
