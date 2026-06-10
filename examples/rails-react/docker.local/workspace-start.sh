#!/bin/bash
set -e

# ── System timezone ───────────────────────────────────────────────────────────
if [ -n "$TZ" ]; then
  echo "$TZ" > /etc/timezone
  ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
  echo "Timezone set to $TZ"
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

# ── Managed services (from services.json via services-start.sh) ───────────────
# services-start.sh is generated host-side from services.json and bind-mounted.
# Pre-create every service log NOW (before code-server boots) so the startup
# terminals' `tail -F` attach to existing files instead of racing the services.
SERVICES_RUNNER=/usr/local/bin/services-start.sh
if [ -f "$SERVICES_RUNNER" ]; then
  source "$SERVICES_RUNNER"
  type precreate_logs &>/dev/null && precreate_logs || true
fi

# ── code-server ───────────────────────────────────────────────────────────────
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

# ── Application services (defined in services.json) ──────────────────────────
# Launched by the generated services-start.sh (sourced above). Edit
# docker.local/services.json to change ports, logs, or start commands — the
# runner, startup terminals, tasks, and URL list all regenerate from it.
echo "Starting application services..."
if type start_services &>/dev/null; then
  start_services
  echo "All services started"
else
  echo "No services-start.sh found — define services in services.json"
fi

# Keep the container alive
exec sleep infinity
