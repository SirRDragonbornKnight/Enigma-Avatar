@echo off
rem ============================================================
rem  Enigma Avatar — double-click this to pop the avatar onto
rem  your desktop. Nothing else shows; right-click the avatar
rem  for the menu (models / size / settings / quit).
rem
rem  Launches the overlay HIDDEN (no lingering console) using
rem  the portable Node setup. No admin required.
rem ============================================================
cd /d "%~dp0"
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Start-Avatar.ps1"
exit
