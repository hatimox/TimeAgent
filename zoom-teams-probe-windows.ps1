# Find the process that runs ONLY during a Zoom or Teams meeting on Windows.
# Run in PowerShell:
#   1. .\zoom-teams-probe-windows.ps1
#   2. Open Zoom/Teams.
#   3. JOIN a meeting   (note which NEW process names appear).
#   4. LEAVE the meeting but keep the app open (note which DISAPPEAR).
#   The name present ONLY during the call is the one to put in Settings.
Write-Host "Watching meeting processes (Ctrl+C to stop)..."
while ($true) {
  $procs = Get-Process |
    Where-Object { $_.ProcessName -match 'zoom|cpthost|aomhost|caphost|teams|msteams|airhost|webex' } |
    Select-Object -ExpandProperty ProcessName -Unique
  $t = Get-Date -Format "HH:mm:ss"
  Write-Host "$t : $($procs -join ', ')"
  Start-Sleep -Seconds 2
}
