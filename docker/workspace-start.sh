#!/bin/bash
# workspace-start.sh — Container startup script
#
# This script runs when a pod container starts. Customize it to:
# 1. Start your database and other services
# 2. Install/update dependencies
# 3. Run migrations or setup tasks
# 4. Start background processes

set -e

# ── System timezone ──────────────────────────────────────────────────────────
if [ -n "$TZ" ]; then
  echo "$TZ" > /etc/timezone
  ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
  echo "Timezone: $TZ"
fi

# ── Remove non-active repos ─────────────────────────────────────────────────
# ISOPOD_REPOS lists repos that are bind-mounted into this pod.
# Remove leftover directories from the image that aren't in the active list.
if [ -n "$ISOPOD_REPOS" ]; then
  IFS=',' read -ra active_repos <<< "$ISOPOD_REPOS"
  for dir in /workspace/*/; do
    [ -d "$dir" ] || continue
    dir_name=$(basename "$dir")
    match=false
    for repo in "${active_repos[@]}"; do
      [ "$repo" = "$dir_name" ] && match=true && break
    done
    if [ "$match" = false ]; then
      rm -rf "$dir"
    fi
  done
fi

# ── Start your services below ───────────────────────────────────────────────
#
# Examples:
#
# # Start PostgreSQL
# su postgres -c "/usr/lib/postgresql/17/bin/pg_ctl -D /pgdata -l /tmp/postgres.log start -w"
#
# # Start Redis
# redis-server --daemonize yes --bind 127.0.0.1
#
# # Install dependencies
# cd /workspace/myapp && bundle install
# cd /workspace/frontend && npm install
#
# # Run migrations
# cd /workspace/myapp && bundle exec rails db:migrate
#
# # Start app services (logs to files so startup terminals can tail them)
# cd /workspace/myapp && bundle exec rails server &> /tmp/rails.log &
# cd /workspace/frontend && npx vite --host 0.0.0.0 --port 4000 &> /tmp/vite.log &
#
# ── HTTPS for app services ──────────────────────────────────────────────────
# If you generate mkcert certs (see docker/certs/), your app services can
# use them too. This avoids mixed-content issues when code-server is HTTPS.
#
# Puma (Rails): use ssl_bind in config/puma.rb:
#   cert_file = "/certs/_wildcard.orb.local+2.pem"
#   key_file = "/certs/_wildcard.orb.local+2-key.pem"
#   if File.exist?(cert_file)
#     ssl_bind "0.0.0.0", ENV.fetch("PORT", 3000), cert: cert_file, key: key_file
#   else
#     port ENV.fetch("PORT", 3000)
#   end
#   Note: don't pass -p to `rails server` — it overrides ssl_bind.
#
# Vite: configure in vite.config.js:
#   import fs from 'fs'
#   const certFile = '/certs/_wildcard.orb.local+2.pem'
#   const keyFile = '/certs/_wildcard.orb.local+2-key.pem'
#   server: {
#     https: fs.existsSync(certFile)
#       ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
#       : undefined,
#     allowedHosts: ['.orb.local'],  // required for OrbStack DNS
#   }
#
# Frontend API URL: derive from window.location so it works with any pod name:
#   const API_URL = `${window.location.protocol}//${window.location.hostname}:3000`

# ── code-server (browser-based VS Code) ─────────────────────────────────────
if command -v code-server &> /dev/null; then
  echo "Starting code-server on port 8443..."

  # Ensure Startup Terminals extension is installed (bind-mount can overwrite build-time install)
  if ! code-server --list-extensions 2>/dev/null | grep -qi "startup-terminals"; then
    echo "Installing Startup Terminals extension..."
    code-server --install-extension /tmp/startup-terminals.vsix 2>/dev/null || true
  fi

  CERT_ARGS=""
  if [ -f /certs/_wildcard.orb.local+2.pem ]; then
    CERT_ARGS="--cert /certs/_wildcard.orb.local+2.pem --cert-key /certs/_wildcard.orb.local+2-key.pem"
    echo "Using trusted mkcert certificates"
  else
    CERT_ARGS="--cert"
    echo "Using self-signed certificate (run mkcert to fix)"
  fi

  code-server \
    --bind-addr 0.0.0.0:8443 \
    --auth none \
    $CERT_ARGS \
    --disable-telemetry \
    /workspace &> /tmp/code-server.log &
  echo "code-server ready at https://$(hostname).orb.local:8443"
fi

echo "Workspace ready"

# Keep the container alive
exec sleep infinity
