# Run this in PowerShell on Windows. It lists Zoom-related processes every 2s.
# 1. Run it.  2. Open Zoom (note processes).  3. JOIN a meeting (note NEW ones).
# 4. LEAVE the meeting but keep Zoom open (note which DISAPPEAR — that's the signal).
# 5. Tell Hatim which process is present ONLY during the call.
Write-Host "Watching Zoom processes (Ctrl+C to stop)..."
while ($true) {
  $procs = Get-Process | Where-Object { $_.ProcessName -match 'zoom|cpthost|aomhost|caphost|airhost' } |
           Select-Object -ExpandProperty ProcessName -Unique
  $t = Get-Date -Format "HH:mm:ss"
  Write-Host "$t : $($procs -join ', ')"
  Start-Sleep -Seconds 2
}
