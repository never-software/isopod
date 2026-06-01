#!/bin/zsh
# tests/test_services.sh — Service manifest generator (lib/helpers/services.sh)
#
# generate_services is a pure host-side transform: services.json -> generated
# surfaces. These tests are Docker-free.

source "$(dirname "$0")/test_helper.sh"

# Write a representative two-service manifest (plus an IDE entry) into DOCKER_DIR.
_write_manifest() {
  cat > "$TEST_DOCKER_DIR/services.json" <<'JSON'
{
  "services": [
    { "id": "ide", "displayName": "IDE", "port": 8443, "protocol": "https",
      "urlLabel": "IDE", "tailInTerminal": false, "autoStart": false },
    { "id": "rails", "displayName": "Rails API", "port": 3000, "protocol": "https",
      "urlLabel": "API", "workdir": "/workspace/example-api", "logPath": "/tmp/rails.log",
      "startCommand": "bundle exec rails server -b 0.0.0.0 -p 3000" },
    { "id": "vite", "displayName": "Frontend", "port": 4000, "protocol": "https",
      "urlLabel": "Frontend", "workdir": "/workspace/example-frontend", "logPath": "/tmp/vite.log",
      "startCommand": "npx vite --host 0.0.0.0 --port 4000" }
  ]
}
JSON
}

# ── settings.json (startup terminals) ─────────────────────────────────────────

test_services_settings_uses_tail_F_and_workdir() {
  setup_test_env
  source_isopod_libs
  _write_manifest

  capture_fn generate_services demo
  assert_exit_code 0

  local settings="$TEST_DOCKER_DIR/code-server/settings.json"
  assert_file_exists "$settings"
  local body=$(<"$settings")
  # robust tailing: tail -F, never tail -f
  assert_contains "$body" "cd /workspace/example-api && tail -F /tmp/rails.log"
  assert_contains "$body" "cd /workspace/example-frontend && tail -F /tmp/vite.log"
  assert_not_contains "$body" "tail -f "
  # IDE has tailInTerminal:false -> no terminal
  assert_not_contains "$body" "8443"
  _pass
}

test_services_settings_preserves_other_keys() {
  setup_test_env
  source_isopod_libs
  mkdir -p "$TEST_DOCKER_DIR/code-server"
  echo '{ "editor.fontSize": 14, "startupTerminals.terminals": [] }' \
    > "$TEST_DOCKER_DIR/code-server/settings.json"
  _write_manifest

  capture_fn generate_services demo
  assert_exit_code 0
  local body=$(<"$TEST_DOCKER_DIR/code-server/settings.json")
  assert_contains "$body" "editor.fontSize"
  assert_contains "$body" "tail -F /tmp/rails.log"
  _pass
}

# ── tasks.json (start/stop/restart) ───────────────────────────────────────────

test_services_tasks_start_stop_restart_per_service() {
  setup_test_env
  source_isopod_libs
  _write_manifest

  capture_fn generate_services demo
  assert_exit_code 0

  local tasks="$TEST_DOCKER_DIR/code-server/tasks.json"
  assert_file_exists "$tasks"
  local body=$(<"$tasks")
  assert_contains "$body" "GENERATED from services.json"
  assert_contains "$body" "Rails API: start"
  assert_contains "$body" "Rails API: stop"
  assert_contains "$body" "Rails API: restart"
  assert_contains "$body" "Frontend: start"
  # stop kills by port via lsof (not brittle pkill)
  assert_contains "$body" "lsof -ti tcp:3000 | xargs -r kill -TERM"
  assert_contains "$body" "lsof -ti tcp:4000 | xargs -r kill -TERM"
  # IDE has no startCommand -> no task
  assert_not_contains "$body" "IDE: start"

  # valid JSON once the leading // header line is stripped
  local parsed
  parsed=$(tail -n +2 "$tasks" | jq '.tasks | length') || _fail "tasks.json not valid JSON"
  assert_eq "$parsed" "6"
  _pass
}

# ── services-start.sh (pre-create + start) ────────────────────────────────────

test_services_runner_precreates_logs_and_starts() {
  setup_test_env
  source_isopod_libs
  _write_manifest

  capture_fn generate_services demo
  assert_exit_code 0

  local runner="$TEST_DOCKER_DIR/services-start.sh"
  assert_file_exists "$runner"
  local body=$(<"$runner")
  assert_contains "$body" "precreate_logs()"
  assert_contains "$body" "start_services()"
  # every log pre-created before code-server boots (this is the race fix)
  assert_contains "$body" ": > '/tmp/rails.log'"
  assert_contains "$body" ": > '/tmp/vite.log'"
  # services launched in background, redirected to their log
  assert_contains "$body" "cd '/workspace/example-api' && bundle exec rails server"
  assert_contains "$body" "&> '/tmp/rails.log' &"
  # runner is valid bash
  bash -n "$runner" || _fail "generated runner has invalid bash syntax"
  _pass
}

test_services_runner_precreate_actually_creates_files() {
  setup_test_env
  source_isopod_libs
  _write_manifest
  capture_fn generate_services demo

  # Functionally exercise precreate_logs with a temp log path.
  cat > "$TEST_DOCKER_DIR/services.json" <<JSON
{ "services": [ { "id": "t", "displayName": "T", "logPath": "$TEST_TMPDIR/t.log",
                  "startCommand": "true" } ] }
JSON
  capture_fn generate_services demo
  ( source "$TEST_DOCKER_DIR/services-start.sh"; precreate_logs )
  assert_file_exists "$TEST_TMPDIR/t.log"
  _pass
}

# ── No manifest -> stub runner so the bind mount always has a source ──────────

test_services_no_manifest_writes_stub_runner() {
  setup_test_env
  source_isopod_libs
  rm -f "$TEST_DOCKER_DIR/services.json"

  capture_fn generate_services demo
  assert_exit_code 0
  local runner="$TEST_DOCKER_DIR/services-start.sh"
  assert_file_exists "$runner"
  local body=$(<"$runner")
  assert_contains "$body" "stub"
  ( source "$runner"; precreate_logs && start_services ) || _fail "stub runner functions failed"
  _pass
}

# ── Failures are surfaced, not swallowed ──────────────────────────────────────

test_services_invalid_json_errors_loudly() {
  setup_test_env
  source_isopod_libs
  echo '{ not json' > "$TEST_DOCKER_DIR/services.json"

  capture_fn generate_services demo
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Invalid JSON"
  _pass
}

# ── urls hook reads the manifest live ─────────────────────────────────────────

test_services_urls_hook_reads_manifest() {
  setup_test_env
  source_isopod_libs
  _write_manifest
  cp "$ISOPOD_ROOT/docker/hooks/urls" "$TEST_DOCKER_DIR/hooks/urls"
  chmod +x "$TEST_DOCKER_DIR/hooks/urls"

  export FEATURE_NAME=demo
  capture "$TEST_DOCKER_DIR/hooks/urls"
  assert_exit_code 0
  # one line per service with a urlLabel, scheme + port from the manifest
  assert_contains "$TEST_STDOUT" "https://demo.orb.local:8443"
  assert_contains "$TEST_STDOUT" "https://demo.orb.local:3000"
  assert_contains "$TEST_STDOUT" "https://demo.orb.local:4000"
  assert_contains "$TEST_STDOUT" "Frontend"
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
