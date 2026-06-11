# Enigma Avatar — desktop overlay launcher (NO admin required).
# Uses portable Node at %LOCALAPPDATA%\node-portable. First run installs Electron.
# Also starts the avatar bus (bus.py) so Enigma/Odysseus can drive emotes; the
# avatar still works fine without it.
$ErrorActionPreference = "Stop"
$node = "$env:LOCALAPPDATA\node-portable"
if (-not (Test-Path "$node\node.exe")) {
  Write-Error "Portable Node not found at $node. Run the Node setup first (see STATUS.md)."
  exit 1
}
$env:Path = "$node;" + $env:Path
Set-Location $PSScriptRoot
if (-not (Test-Path "node_modules\electron") -or -not (Test-Path "node_modules\three") -or -not (Test-Path "node_modules\@pixiv\three-vrm")) {
  Write-Host "Installing dependencies (electron + three + three-vrm; one-time, ~200MB)..." -ForegroundColor Cyan
  & "$node\npm.cmd" install
}

# Avatar bus — AI emote control. Best-effort: needs Python + `websockets`.
$bus = $null
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if ($python) {
  Write-Host "Starting avatar bus (AI emote control on ws://127.0.0.1:8765)..." -ForegroundColor DarkGray
  $bus = Start-Process -FilePath $python -ArgumentList "`"$PSScriptRoot\bus.py`"" -WindowStyle Hidden -PassThru
} else {
  Write-Host "Python not found - skipping the AI bus (the avatar still works; emotes just won't be remote-driven)." -ForegroundColor Yellow
}

Write-Host "Launching Enigma Avatar overlay." -ForegroundColor Green
Write-Host "  Right-click the avatar for the menu (models, emotes, toggles)." -ForegroundColor DarkGray
Write-Host "  Ctrl+Alt+Q quit   Ctrl+Alt+A toggle click-through   1/2/3 swap model   H hide panel" -ForegroundColor DarkGray
try {
  # Tee the overlay's output to a log — main.js writes its quit-reason / window-set / crash
  # diagnostics to stderr, and without this they were invisible when launched hidden.
  $avatarLog = Join-Path $env:TEMP "enigma_avatar.log"
  & "$node\npm.cmd" start 2>&1 | Tee-Object -FilePath $avatarLog
} finally {
  if ($bus -and -not $bus.HasExited) { Stop-Process -Id $bus.Id -Force -ErrorAction SilentlyContinue }
}
