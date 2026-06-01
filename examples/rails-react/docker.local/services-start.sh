#!/bin/bash
# GENERATED from services.json — do not edit; edit services.json and re-run isopod up.
# Sourced by workspace-start.sh; defines precreate_logs and start_services.

precreate_logs() {
  : > '/tmp/rails.log'
  : > '/tmp/vite.log'
  return 0
}

start_services() {
  ( cd '/workspace/example-api' && rm -f tmp/pids/server.pid; bundle exec rails server -b 0.0.0.0 -p 3000 ) &> '/tmp/rails.log' &
  ( cd '/workspace/example-frontend' && VITE_API_URL=http://localhost:3000 npx vite --host 0.0.0.0 --port 4000 ) &> '/tmp/vite.log' &
  return 0
}
