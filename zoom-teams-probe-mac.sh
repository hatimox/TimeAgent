#!/usr/bin/env bash
# Find the process that runs ONLY during a Zoom or Teams meeting on macOS.
# Usage:
#   1. Run:  ./zoom-teams-probe-mac.sh
#   2. Open Zoom/Teams (note processes).
#   3. JOIN a meeting   (note which NEW process names appear).
#   4. LEAVE the meeting but keep the app open (note which DISAPPEAR).
#   The name that is present ONLY during the call is the one to use.
echo "Watching meeting-related processes (Ctrl-C to stop)..."
printf '%-9s %s\n' "time" "running meeting-ish processes"
while true; do
  procs=$(ps axco command 2>/dev/null \
    | grep -iE 'cpthost|aomhost|caphost|teams|msteams|zoom|airhost|webex' \
    | sort -u | tr '\n' ' ')
  printf '%-9s %s\n' "$(date +%H:%M:%S)" "${procs:-none}"
  sleep 2
done
