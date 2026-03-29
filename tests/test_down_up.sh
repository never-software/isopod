#!/bin/zsh
# tests/test_down_up.sh — Tests 173–187: down and up commands

source "$(dirname "$0")/test_helper.sh"

# ── down validation (Tests 173–174) ──────────────────────────────────────────

test_173_down_no_name_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_down
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod down"
  _pass
}

test_174_down_nonexistent_pod_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_down "nonexistent"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

# ── down behavior (Tests 175–179) ────────────────────────────────────────────

test_175_down_stops_running_container() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  assert_container_running "test-feat"
  capture_fn cmd_down "test-feat"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Container stopped"
  assert_contains "$TEST_OUTPUT" "data preserved"
  assert_container_not_running "test-feat"
  _pass
}

test_176_down_runs_teardown_workspace() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"

  local marker="$TEST_TMPDIR/teardown_ran"
  cat > "$TEST_DOCKER_DIR/hooks/teardown-workspace" <<EOF
#!/bin/zsh
echo "teardown" > "$marker"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/teardown-workspace"

  capture_fn cmd_down "test-feat"
  assert_exit_code 0
  assert_file_exists "$marker"
  _pass
}

test_177_down_preserves_data() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  capture_fn cmd_down "test-feat"
  assert_exit_code 0
  # Pod directory should still exist
  assert_dir_exists "$TEST_PODS_DIR/test-feat"
  assert_file_exists "$TEST_PODS_DIR/test-feat/api/README.md"
  _pass
}

test_178_down_uses_compose_stop() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  capture_fn cmd_down "test-feat"
  assert_exit_code 0
  # Verify the container is actually stopped (not removed)
  assert_container_not_running "test-feat"
  # Pod dir still exists (compose stop preserves data)
  assert_dir_exists "$TEST_PODS_DIR/test-feat"
  _pass
}

test_179_teardown_no_isopod_removing_on_down() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"

  local marker="$TEST_TMPDIR/removing_flag"
  cat > "$TEST_DOCKER_DIR/hooks/teardown-workspace" <<EOF
#!/bin/zsh
echo "ISOPOD_REMOVING=\${ISOPOD_REMOVING:-unset}" > "$marker"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/teardown-workspace"

  capture_fn cmd_down "test-feat"
  assert_exit_code 0
  local flag_value=$(cat "$marker")
  assert_contains "$flag_value" "unset"
  _pass
}

# ── up validation (Tests 180–181) ────────────────────────────────────────────

test_180_up_no_name_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_up
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod up"
  _pass
}

test_181_up_nonexistent_pod_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_up "nonexistent"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

# ── up behavior (Tests 182–187) ──────────────────────────────────────────────

test_183_up_runs_ensure_image() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  ensure_test_image
  capture_fn cmd_up "test-feat"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Workspace image"
  _pass
}

test_185_up_runs_post_up_hook() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  ensure_test_image

  local marker="$TEST_TMPDIR/post_up_ran"
  cat > "$TEST_DOCKER_DIR/hooks/post-up" <<EOF
#!/bin/zsh
echo "post-up CONTAINER=\$CONTAINER FEATURE_NAME=\$FEATURE_NAME" > "$marker"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/post-up"

  capture_fn cmd_up "test-feat"
  assert_exit_code 0
  assert_file_exists "$marker"
  local recorded=$(cat "$marker")
  assert_contains "$recorded" "CONTAINER=test-feat"
  assert_contains "$recorded" "FEATURE_NAME=test-feat"
  _pass
}

test_186_up_runs_setup_workspace() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  ensure_test_image
  capture_fn cmd_up "test-feat"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Workspace ready"
  _pass
}

test_187_up_prints_complete() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  ensure_test_image
  capture_fn cmd_up "test-feat"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Up complete"
  _pass
}

test_up_starts_container_via_compose() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  ensure_test_image
  capture_fn cmd_up "test-feat"
  assert_exit_code 0
  assert_container_running "test-feat"
  _pass
}

# ── Missing: Tests 182, 184 ──────────────────────────────────────────────────

test_182_up_starts_stopped_container() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  ensure_test_image
  # Start then stop
  start_test_container "test-feat"
  capture_fn cmd_down "test-feat"
  assert_exit_code 0
  assert_container_not_running "test-feat"
  # Now bring it back up
  capture_fn cmd_up "test-feat"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Starting container"
  assert_container_running "test-feat"
  _pass
}

test_184_up_waits_for_container() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  ensure_test_image
  capture_fn cmd_up "test-feat"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Waiting for container"
  assert_container_running "test-feat"
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
