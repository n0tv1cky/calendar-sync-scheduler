#!/bin/bash
# Runs the calendar sync, unattended (launchd).
#
# DEPLOYED COPY: launchd actually executes ~/.calendar-sync/run.sh, not this
# file. macOS TCC blocks background (non-GUI) processes from executing
# scripts that live inside ~/Documents -- but node itself reading
# sync-schedule.mjs from inside Documents is fine, only the script launchd
# directly invokes has to live outside it. Re-run install-launchd.sh after
# editing this file to redeploy the copy.

set -euo pipefail

SYNC_SCRIPT="/Users/n0tv1cky/Documents/Personal/masters/projects/calendar-sync/sync-schedule.mjs"

exec node "$SYNC_SCRIPT" "$@"
