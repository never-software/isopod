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

# ── Remove stale .git at /workspace (prevents phantom "workspace" repo in SCM)
rm -rf /workspace/.git

# ── code-server (browser-based VS Code) ─────────────────────────────────────
if command -v code-server &> /dev/null; then
  echo "Starting code-server on port 8443..."

  # Ensure Startup Terminals extension is installed (bind-mount can overwrite build-time install)
  if ! code-server --list-extensions 2>/dev/null | grep -qi "startup-terminals"; then
    echo "Installing Startup Terminals extension..."
    code-server --install-extension /tmp/startup-terminals.vsix 2>/dev/null || true
  fi

  # Generate multi-root workspace file so each repo gets its own
  # Explorer root and Source Control section. Keep it outside /workspace so it
  # does not become pod template material or conflict with pod-local files.
  WORKSPACE_FILE="/tmp/workspace.code-workspace"
  if [ -n "$ISOPOD_REPOS" ]; then
    IFS=',' read -ra repos <<< "$ISOPOD_REPOS"
    FOLDERS=""
    for repo in "${repos[@]}"; do
      [ -n "$FOLDERS" ] && FOLDERS="$FOLDERS,"
      FOLDERS="$FOLDERS{\"path\":\"/workspace/$repo\",\"name\":\"$repo\"}"
    done
    echo "{\"folders\":[$FOLDERS],\"settings\":{}}" > "$WORKSPACE_FILE"
    echo "Generated multi-root workspace for: $ISOPOD_REPOS"
    CODE_TARGET="$WORKSPACE_FILE"
  else
    CODE_TARGET="/workspace"
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
    "$CODE_TARGET" &> /tmp/code-server.log &
  echo "code-server ready at https://$(hostname).orb.local:8443"
fi

echo "Workspace ready"

# Keep the container alive
exec sleep infinity
