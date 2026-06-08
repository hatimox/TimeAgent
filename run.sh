#!/usr/bin/env bash
# Launch TimeAgent in dev. Unsets ELECTRON_RUN_AS_NODE, which some shells/sandboxes
# set — it forces Electron into headless Node mode (no GUI / app is undefined).
cd "$(dirname "$0")"
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .
