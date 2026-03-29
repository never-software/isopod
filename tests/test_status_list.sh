#!/bin/zsh
# tests/test_status_list.sh — Tests 162–172: status and list commands

source "$(dirname "$0")/test_helper.sh"

# ── status (Tests 162–167) ───────────────────────────────────────────────────

test_162_status_no_pods() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_status
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "No pods"
  _pass
}

test_164_status_specific_pod_nonexistent() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_status "nonexistent"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

test_165_status_specific_pod() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  capture_fn cmd_status "test-feat"
  assert_exit_code 0
  # Should show the feature name in output
  assert_contains "$TEST_OUTPUT" "test-feat"
  _pass
}

test_167_status_all_pods() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "feat-a" "api"
  create_test_pod "feat-b" "api"
  capture_fn cmd_status
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "feat-a"
  assert_contains "$TEST_OUTPUT" "feat-b"
  _pass
}

# ── list (Tests 168–172) ─────────────────────────────────────────────────────

test_168_list_no_pods() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "No pods"
  _pass
}

test_170_list_shows_pods_with_details() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"
  capture_fn cmd_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "test-feat"
  assert_contains "$TEST_OUTPUT" "container"
  _pass
}

test_171_list_shows_primary() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"
  capture_fn cmd_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Primary"
  _pass
}

test_172_list_shows_branch_per_repo() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "my-feature" "api"
  capture_fn cmd_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "my-feature"
  _pass
}

test_list_shows_active_pods_header() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Active pods"
  _pass
}

# ── Missing: Tests 163, 166, 169 ────────────────────────────────────────────

test_163_status_requires_docker() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # cmd_status calls require_docker which calls docker info
  capture_fn cmd_status
  assert_exit_code 0
  _pass
}

test_166_status_specific_pod_stopped() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  # Start then stop the container so it exists but is not running
  start_test_container "test-feat"
  local project=$(compose_project "test-feat")
  local compose_file=$(compose_file_for "test-feat")
  docker compose -p "$project" -f "$compose_file" stop >/dev/null 2>&1
  capture_fn cmd_status "test-feat"
  assert_exit_code 0
  # Should show the pod name in output regardless of container state
  assert_contains "$TEST_OUTPUT" "test-feat"
  _pass
}

test_169_list_unknown_branch_fallback() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  # Create a pod with a repo dir that is NOT a git repo
  # This triggers the "unknown" fallback in cmd_list
  local pod_dir="$TEST_PODS_DIR/test-feat"
  mkdir -p "$pod_dir/api"
  echo "not a git repo" > "$pod_dir/api/README.md"
  cat > "$pod_dir/docker-compose.yml" <<EOF
services:
  workspace:
    image: $TEST_WORKSPACE_IMAGE
    container_name: test-feat
    command: ["sleep", "infinity"]
EOF
  capture_fn cmd_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "test-feat"
  assert_contains "$TEST_OUTPUT" "unknown"
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
