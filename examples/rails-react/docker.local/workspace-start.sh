#!/bin/bash
set -e

# ── System timezone ───────────────────────────────────────────────────────────
if [ -n "$TZ" ]; then
  echo "$TZ" > /etc/timezone
  ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
  echo "Timezone set to $TZ"
fi

# ── Remove non-active repos ──────────────────────────────────────────────────
if [ -n "$ISOPOD_REPOS" ]; then
  IFS=',' read -ra active_repos <<< "$ISOPOD_REPOS"
  for dir in /workspace/*/; do
    [ -d "$dir" ] || continue
    dir_name=$(basename "$dir")
    match=false
    for repo in "${active_repos[@]}"; do
      if [ "$repo" = "$dir_name" ]; then
        match=true
        break
      fi
    done
    if [ "$match" = false ]; then
      rm -rf "$dir"
    fi
  done
fi

# ── PostgreSQL ────────────────────────────────────────────────────────────────
PGDATA=/pgdata

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "Initializing PostgreSQL..."
  su postgres -c "/usr/lib/postgresql/17/bin/initdb -D $PGDATA"

  cat > "$PGDATA/pg_hba.conf" <<PGHBA
local   all   all                 trust
host    all   all   127.0.0.1/32  trust
host    all   all   ::1/128       trust
PGHBA

  cat >> "$PGDATA/postgresql.conf" <<PGCONF
shared_buffers = 128MB
work_mem = 16MB
maintenance_work_mem = 256MB
listen_addresses = 'localhost'
fsync = off
full_page_writes = off
synchronous_commit = off
timezone = '${TZ:-UTC}'
log_timezone = '${TZ:-UTC}'
PGCONF
fi

echo "Starting PostgreSQL..."
su postgres -c "/usr/lib/postgresql/17/bin/pg_ctl -D $PGDATA -l /tmp/postgres.log start -w"
echo "PostgreSQL ready"

# ── Install dependencies ─────────────────────────────────────────────────────
if [ -f /workspace/example-api/Gemfile ]; then
  echo "Installing API gems..."
  cd /workspace/example-api
  bundle install > /tmp/bundle-install.log 2>&1 && echo "bundle install complete" || echo "bundle install failed (see /tmp/bundle-install.log)"
fi

if [ -f /workspace/example-frontend/package.json ]; then
  echo "Installing frontend dependencies..."
  cd /workspace/example-frontend
  npm install > /tmp/npm-install.log 2>&1 && echo "npm install complete" || echo "npm install failed (see /tmp/npm-install.log)"
fi

# ── Database setup ────────────────────────────────────────────────────────────
if [ ! -f "$PGDATA/.databases_ready" ] && [ -f /workspace/example-api/Gemfile ]; then
  echo "Setting up databases (first boot)..."
  cd /workspace/example-api

  echo "  Creating + migrating + seeding dev database..."
  RAILS_ENV=development bundle exec rails db:create db:migrate db:seed > /tmp/db-dev.log 2>&1
  echo "  Dev database ready"

  echo "  Creating + migrating test database..."
  RAILS_ENV=test bundle exec rails db:create db:migrate > /tmp/db-test.log 2>&1
  echo "  Test database ready"

  touch "$PGDATA/.databases_ready"
  echo "All databases ready"

elif [ -f /workspace/example-api/Gemfile ] && [ -f "$PGDATA/.databases_ready" ]; then
  echo "Running pending migrations..."
  cd /workspace/example-api
  RAILS_ENV=development bundle exec rails db:migrate > /tmp/migrate-dev.log 2>&1 && echo "  Dev migrated" || echo "  Dev migrate failed"
  RAILS_ENV=test bundle exec rails db:migrate > /tmp/migrate-test.log 2>&1 && echo "  Test migrated" || echo "  Test migrate failed"
  echo "Migrations complete"
fi

# ── code-server ───────────────────────────────────────────────────────────────
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

# ── Application services ─────────────────────────────────────────────────────
echo "Starting application services..."

# Clean up stale PID files
rm -f /workspace/example-api/tmp/pids/server*.pid 2>/dev/null || true

if [ -f /workspace/example-api/Gemfile ]; then
  cd /workspace/example-api
  bundle exec rails server &> /tmp/rails.log &
  echo "Rails API on port 3000"
fi

if [ -f /workspace/example-frontend/package.json ]; then
  cd /workspace/example-frontend
  npx vite --host 0.0.0.0 --port 4000 &> /tmp/vite.log &
  echo "Vite frontend on port 4000"
fi

echo "All services started"

# Keep the container alive
exec sleep infinity
