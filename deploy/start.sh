#!/bin/sh
# Start FalkorDB (Redis + module) in the background, wait for it, then the dashboard.
/var/lib/falkordb/bin/run.sh &
until redis-cli ping >/dev/null 2>&1; do sleep 0.3; done
exec node /app/dist/server.js
