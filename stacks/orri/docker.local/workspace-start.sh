#!/bin/bash
set -e

# ── System timezone ───────────────────────────────────────────────────────────
# Set the system timezone from the TZ env var so PostgreSQL, Rails, and all
# processes agree on the timezone. Without this, /etc/timezone stays Etc/UTC
# from the base image, and PostgreSQL ignores the TZ env var.
if [ -n "$TZ" ]; then
  echo "$TZ" > /etc/timezone
  ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
  echo "🕐 System timezone set to $TZ"
fi

# ── PostgreSQL ────────────────────────────────────────────────────────────────
PGDATA=/pgdata

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "🗄️  Initializing PostgreSQL data directory..."
  su postgres -c "/usr/lib/postgresql/17/bin/initdb -D $PGDATA"

  # Trust auth for all connections (dev environment)
  cat > "$PGDATA/pg_hba.conf" <<PGHBA
local   all   all                 trust
host    all   all   127.0.0.1/32  trust
host    all   all   ::1/128       trust
PGHBA

  # Performance tuning + listen on localhost only
  # (fsync=off is safe for ephemeral dev environments and drastically speeds up seeds)
  cat >> "$PGDATA/postgresql.conf" <<PGCONF
shared_buffers = 128MB
work_mem = 16MB
maintenance_work_mem = 256MB
listen_addresses = 'localhost'
fsync = off
full_page_writes = off
synchronous_commit = off
timezone = '${TZ:-Europe/London}'
log_timezone = '${TZ:-Europe/London}'
PGCONF
fi

echo "🗄️  Starting PostgreSQL..."
su postgres -c "/usr/lib/postgresql/17/bin/pg_ctl -D $PGDATA -l /tmp/postgres.log start -w"
# Create matching Postgres role for the 'dev' OS user.
su postgres -c "psql -c \"CREATE ROLE dev WITH LOGIN SUPERUSER;\"" 2>/dev/null || true
echo "✓ PostgreSQL ready"

# ── Redis ─────────────────────────────────────────────────────────────────────
echo "🔴 Starting Redis..."
redis-server --daemonize yes --logfile /tmp/redis.log --bind 127.0.0.1
echo "✓ Redis ready"

# ── Helper: run a command with live log tailing ───────────────────────────────
run_with_log() {
  local label="$1"
  local logfile="$2"
  shift 2

  : > "$logfile"  # create/truncate log file
  "$@" > "$logfile" 2>&1 &
  local cmd_pid=$!
  tail -f "$logfile" 2>/dev/null | sed "s/^/    [$label] /" &
  local tail_pid=$!
  wait $cmd_pid || { kill $tail_pid 2>/dev/null || true; echo "  ✗ $label FAILED (see $logfile)"; return 1; }
  kill $tail_pid 2>/dev/null || true
}

# ── Runtime ownership for bind-mounted paths ─────────────────────────────────
# Repo bind mounts and anonymous volumes can surface with host ownership that
# doesn't match the dev user. Chown'ing once at boot is cheap (top-level only)
# and avoids the recursive scan the old setup did.
chown dev:dev /workspace
for repo_dir in /workspace/*/; do
  chown dev:dev "$repo_dir" 2>/dev/null || true
done
# Anonymous volumes for tmp/log/node_modules/pids — ensure dev can write.
for writeable in /workspace/api/tmp /workspace/api/log /workspace/api/tmp/pids \
                 /workspace/frontend/tmp /workspace/frontend/log \
                 /workspace/frontend/node_modules; do
  [ -d "$writeable" ] && chown -R dev:dev "$writeable" 2>/dev/null || true
done

# ── SSH agent socket: make the host-bound socket dev-accessible ─────────────
# The socket is bind-mounted from the host and starts with host ownership.
# Unix-socket connect() permission checks fail for UID 1000 unless we flip
# ownership to dev. Safe: only affects the in-container view of the socket.
if [ -S /ssh-agent ]; then
  chown dev:dev /ssh-agent 2>/dev/null || true
  chmod 660 /ssh-agent 2>/dev/null || true
fi

# Forward the service env vars dev's login shells (and gosu-wrapped processes)
# expect. .profile sources this so terminals opened in code-server see them.
env | grep -E '^(CLAUDE_CODE_|ANTHROPIC_|QDRANT_|OPENAI_|EMBEDDING_|BUNDLE_|RAILS_|NODE_|CI|E2E_|PGUSER|REDIS_|TZ|ISOPOD_|STACK_|SSH_AUTH_SOCK|DD_TRACE_|GEMFURY_|GH_|GITHUB_)' \
  | sed 's/^/export /' > /home/dev/.pod_env
chown dev:dev /home/dev/.pod_env
grep -q 'pod_env' /home/dev/.profile 2>/dev/null || \
  echo '[ -f ~/.pod_env ] && . ~/.pod_env' >> /home/dev/.profile
chown dev:dev /home/dev/.profile 2>/dev/null || true

# ── Materialize per-stack SSH identities into /home/dev/.ssh ────────────────
# Bind mount /opt/stack-ssh exposes stacks/<stack>/docker.local/ssh/ as a
# read-only source. We copy (not bind-mount directly to ~/.ssh) so that file
# ownership is dev:dev and modes satisfy SSH StrictModes — host-side
# ownership through virtiofs doesn't always survive the trip.
if [ -d /opt/stack-ssh ]; then
  mkdir -p /home/dev/.ssh
  cp -a /opt/stack-ssh/. /home/dev/.ssh/
  chown -R dev:dev /home/dev/.ssh
  chmod 700 /home/dev/.ssh
  find /home/dev/.ssh -maxdepth 1 -type f ! -name '*.pub' ! -name 'known_hosts' ! -name 'config' -exec chmod 600 {} +
  find /home/dev/.ssh -maxdepth 1 -type f \( -name '*.pub' -o -name 'known_hosts' -o -name 'config' \) -exec chmod 644 {} +
fi

# Skip Claude Code's first-run dialogs (theme picker, login picker, workspace
# trust dialog, bypass-permissions disclaimer). Claude's user-level state lives
# in ~/.claude.json (NOT ~/.claude/settings.json), which is wiped on every
# container recreation. Merge our flags on every startup — even if claude has
# already created the file — so a flag claude reset/dropped is re-enforced.
if command -v claude &> /dev/null; then
  CLAUDE_VERSION=$(gosu dev claude --version 2>/dev/null | awk '{print $1}')
  if [ -n "$CLAUDE_VERSION" ]; then
    gosu dev python3 - "$CLAUDE_VERSION" <<'PYEOF' > /dev/null
import json, os, sys, hashlib
version = sys.argv[1]
home = os.path.expanduser("~")
path = f"{home}/.claude.json"
data = {}
if os.path.exists(path):
    try: data = json.load(open(path))
    except (json.JSONDecodeError, OSError): data = {}
# Set defaults only when missing — preserve any existing values
for k, v in {
    "hasCompletedOnboarding": True,
    "lastOnboardingVersion": version,
    "firstStartTime": "2026-01-01T00:00:00.000Z",
    "userID": hashlib.sha256(b"isopod-pod").hexdigest(),
    "migrationVersion": 12,
    "opusProMigrationComplete": True,
    "sonnet1m45MigrationComplete": True,
}.items():
    data.setdefault(k, v)
# Force these to True every time — overrides any claude reset
data["bypassPermissionsModeAccepted"] = True
data["autoModeOptInDismissed"] = True
data["hasResetAutoModeOptInForDefaultOffer"] = True
# Pre-trust /workspace and every immediate subdir
projects = data.setdefault("projects", {})
candidates = ["/workspace"]
if os.path.isdir("/workspace"):
    candidates += [f"/workspace/{d}" for d in os.listdir("/workspace") if os.path.isdir(f"/workspace/{d}")]
for p in candidates:
    proj = projects.setdefault(p, {})
    proj.setdefault("hasTrustDialogAccepted", True)
    proj.setdefault("hasCompletedProjectOnboarding", True)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
PYEOF
    echo "✓ Synced ~/.claude.json (Claude $CLAUDE_VERSION — onboarding/trust/bypass flags enforced)"
  fi
fi

# Helper: run a command as dev with the pod env loaded.
as_dev() {
  gosu dev bash -lc "$*"
}

# ── Remove stale .git at /workspace (prevents phantom "workspace" repo in SCM)
rm -rf /workspace/.git

# ── code-server (browser-based VS Code) ──────────────────────────────────────
# Runs as 'dev' so every terminal, task, and tailed log inherits that user —
# no more root/dev split when restarting services from inside the IDE.
if command -v code-server &> /dev/null; then
  echo "🌐 Starting code-server on port 8443 as dev..."

  if ! gosu dev code-server --list-extensions 2>/dev/null | grep -qi "startup-terminals"; then
    echo "📦 Installing Startup Terminals extension..."
    gosu dev code-server --install-extension /tmp/startup-terminals.vsix 2>/dev/null || true
  fi

  CERT_ARGS=""
  if [ -f /certs/_wildcard.orb.local+2.pem ]; then
    CERT_ARGS="--cert /certs/_wildcard.orb.local+2.pem --cert-key /certs/_wildcard.orb.local+2-key.pem"
    echo "🔒 Using trusted mkcert certificates"
  else
    CERT_ARGS="--cert"
    echo "⚠️  Using self-signed certificate (run mkcert to fix)"
  fi

  # Generate multi-root workspace file so each repo gets its own
  # Explorer root and Source Control section. Keep it outside /workspace so it
  # does not become pod template material or conflict with pod-local files.
  WORKSPACE_FILE="/home/dev/workspace.code-workspace"
  if [ -n "$ISOPOD_REPOS" ]; then
    IFS=',' read -ra repos <<< "$ISOPOD_REPOS"
    FOLDERS=""
    for repo in "${repos[@]}"; do
      [ -n "$FOLDERS" ] && FOLDERS="$FOLDERS,"
      FOLDERS="$FOLDERS{\"path\":\"/workspace/$repo\",\"name\":\"$repo\"}"
    done
    echo "{\"folders\":[$FOLDERS],\"settings\":{}}" > "$WORKSPACE_FILE"
    chown dev:dev "$WORKSPACE_FILE"
    echo "Generated multi-root workspace for: $ISOPOD_REPOS"
    CODE_TARGET="$WORKSPACE_FILE"
  else
    CODE_TARGET="/workspace"
  fi

  gosu dev code-server \
    --bind-addr 0.0.0.0:8443 \
    --auth none \
    $CERT_ARGS \
    --disable-telemetry \
    "$CODE_TARGET" &> /tmp/code-server.log &
  echo "✓ code-server ready at https://$(hostname).orb.local:8443"
fi

# ── Install dependencies in parallel ─────────────────────────────────────────
BUNDLE_PID=""
PNPM_PID=""

if [ -f /workspace/api/Gemfile ]; then
  echo "📦 Installing API dependencies (background)..."
  as_dev "cd /workspace/api && bundle install" > /tmp/bundle-install.log 2>&1 &
  BUNDLE_PID=$!
fi

if [ -f /workspace/frontend/package.json ]; then
  echo "📦 Installing frontend dependencies (background)..."
  as_dev "cd /workspace/frontend && pnpm install --frozen-lockfile" > /tmp/pnpm-install.log 2>&1 &
  PNPM_PID=$!
fi

# ── Vite dev servers (parallel with bundle install + seed) ───────────────────
# Vite has no dependency on Rails or the database — only on pnpm install
# (~20s). Wait for pnpm here in the parent shell (so `wait` actually works on
# $PNPM_PID), then background-fork the frontend dev servers. The slow bundle
# install + Rails seed continue independently.
if [ -n "$PNPM_PID" ] && [ -f /workspace/frontend/package.json ]; then
  if wait "$PNPM_PID"; then
    echo "✓ pnpm install complete"
    as_dev "cd /workspace/frontend && (pnpm exec nx reset 2>/dev/null || rm -rf .nx)"
    as_dev "cd /workspace/frontend && NX_DAEMON=false pnpm exec nx dev hub     --host 0.0.0.0 --port 5200" &> /tmp/vite-hub.log &
    as_dev "cd /workspace/frontend && NX_DAEMON=false pnpm exec nx dev my-orri --host 0.0.0.0 --port 5201" &> /tmp/vite-my-orri.log &
    echo "✓ Vite hub (5200) + my-orri (5201)"
  else
    echo "⚠ pnpm install failed (see /tmp/pnpm-install.log) — skipping Vite"
  fi
fi

# ── Wait for bundle install before any Rails work ────────────────────────────
if [ -n "$BUNDLE_PID" ]; then
  if wait "$BUNDLE_PID"; then
    echo "✓ bundle install complete"
  else
    echo "⚠ bundle install failed (see /tmp/bundle-install.log)"
  fi
fi

# ── First boot: set up databases ──────────────────────────────────────────────
# Schemas (create + migrate) run synchronously — Rails servers below need the
# DBs to exist. Slow seed steps run in the background once schemas are ready,
# so Rails can start serving immediately while data populates behind the scenes.
if [ ! -f "$PGDATA/.databases_ready" ] && [ -f /workspace/api/Gemfile ]; then
  echo "🌱 Setting up database schemas (first boot)..."

  echo "  → Dev database (create + migrate)..."
  run_with_log "dev" /tmp/db-dev.log \
    gosu dev bash -lc "cd /workspace/api && RAILS_ENV=development bundle exec rails db:create db:migrate"
  echo "  ✓ Dev schema ready"

  echo "  → Test database (create + migrate)..."
  run_with_log "test" /tmp/db-test.log \
    gosu dev bash -lc "cd /workspace/api && RAILS_ENV=test bundle exec rails db:create db:migrate"
  echo "  ✓ Test schema ready"

  echo "  → CI database (create + migrate)..."
  run_with_log "ci" /tmp/db-ci.log \
    gosu dev bash -lc "cd /workspace/api && RAILS_ENV=ci bundle exec rails db:create db:migrate"
  echo "  ✓ CI schema ready"

  echo "🌱 Schemas ready — seeds running in background (Rails will start now)"

  # Seed in background so Rails is reachable immediately. The sentinel file
  # lets subsequent boots skip the schema setup once seeds finish at least once.
  (
    echo "" >> /tmp/db-dev.log
    echo "[seed] → Dev seed:staging starting..." >> /tmp/db-dev.log
    if gosu dev bash -lc "cd /workspace/api && RAILS_ENV=development bundle exec rails db:seed:staging" >> /tmp/db-dev.log 2>&1; then
      echo "[seed] ✓ Dev seed complete" >> /tmp/db-dev.log
    else
      echo "[seed] ⚠ Dev seed failed" >> /tmp/db-dev.log
    fi

    echo "" >> /tmp/db-ci.log
    echo "[seed] → CI seed:ci starting..." >> /tmp/db-ci.log
    if gosu dev bash -lc "cd /workspace/api && RAILS_ENV=ci bundle exec rails db:seed:ci" >> /tmp/db-ci.log 2>&1; then
      echo "[seed] ✓ CI seed complete" >> /tmp/db-ci.log
      touch "$PGDATA/.databases_ready"
    else
      echo "[seed] ⚠ CI seed failed — not marking databases_ready" >> /tmp/db-ci.log
    fi
  ) &

elif [ -f /workspace/api/Gemfile ] && [ -f "$PGDATA/.databases_ready" ]; then
  # ── Subsequent boots: run pending migrations ──────────────────────────────
  # The base DB cache is a snapshot from refresh-cache. When a pod has
  # newer code (with new migrations), they need to be applied. Idempotent —
  # if there are no pending migrations, it finishes instantly.
  echo "▸ Running pending migrations..."

  as_dev "cd /workspace/api && RAILS_ENV=development bundle exec rails db:migrate" > /tmp/migrate-dev.log 2>&1 && echo "  ✓ Dev migrated" || echo "  ⚠ Dev migrate failed"
  as_dev "cd /workspace/api && RAILS_ENV=test bundle exec rails db:migrate" > /tmp/migrate-test.log 2>&1 && echo "  ✓ Test migrated" || echo "  ⚠ Test migrate failed"
  as_dev "cd /workspace/api && RAILS_ENV=ci bundle exec rails db:migrate" > /tmp/migrate-ci.log 2>&1 && echo "  ✓ CI migrated" || echo "  ⚠ CI migrate failed"

  echo "✓ Migrations complete"
fi

# ── Clean up stale PID files ──────────────────────────────────────────────────
rm -f /workspace/api/tmp/pids/server*.pid 2>/dev/null || true

# ── Rails servers (depend on bundle install + db) ────────────────────────────
echo "🚀 Starting application services..."

if [ -f /workspace/api/Gemfile ]; then
  as_dev "cd /workspace/api && bundle exec rails server -b 0.0.0.0 -p 3000" &> /tmp/rails-dev.log &
  echo "✓ Rails (development) on port 3000"

  as_dev "cd /workspace/api && RAILS_ENV=ci bundle exec rails server -b 0.0.0.0 -p 3001 -P /workspace/api/tmp/pids/server-ci.pid" &> /tmp/rails-ci.log &
  echo "✓ Rails (CI) on port 3001"
fi

# Vite is launched earlier (before seed) so it doesn't wait on Rails work.

# Keep the container alive
exec sleep infinity
