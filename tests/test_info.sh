#!/bin/zsh
# tests/test_info.sh — Tests for the info command

source "$(dirname "$0")/test_helper.sh"

# ── No pods ─────────────────────────────────────────────────────────────────

test_info_no_pods() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_info
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Pods & Containers"
  assert_contains "$TEST_OUTPUT" "No pods"
  assert_contains "$TEST_OUTPUT" "Volumes"
  assert_contains "$TEST_OUTPUT" "Cache"
  _pass
}

# ── Shows pods with container status ────────────────────────────────────────

test_info_shows_running_pod() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  capture_fn cmd_info
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "test-feat"
  assert_contains "$TEST_OUTPUT" "Up"
  _pass
}

test_info_shows_stopped_pod() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  local project=$(compose_project "test-feat")
  local compose_file=$(compose_file_for "test-feat")
  docker compose -p "$project" -f "$compose_file" stop >/dev/null 2>&1
  capture_fn cmd_info
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "test-feat"
  assert_contains "$TEST_OUTPUT" "Exited"
  _pass
}

test_info_shows_repo_branches() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "my-feature" "api"
  capture_fn cmd_info
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "api:"
  assert_contains "$TEST_OUTPUT" "my-feature"
  _pass
}

# ── Volumes section ─────────────────────────────────────────────────────────

test_info_no_volumes() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_info
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Volumes"
  assert_contains "$TEST_OUTPUT" "No isopod volumes"
  _pass
}

test_info_shows_pod_volumes() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  capture_fn cmd_info
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Pod data"
  assert_contains "$TEST_OUTPUT" "_data"
  _pass
}

test_info_shows_snapshot_volumes() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  docker volume create "isopod-snap-my-snap" >/dev/null 2>&1
  capture_fn cmd_info
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Snapshots"
  assert_contains "$TEST_OUTPUT" "my-snap"
  docker volume rm "isopod-snap-my-snap" >/dev/null 2>&1 || true
  _pass
}

# ── Cache section ───────────────────────────────────────────────────────────

test_info_shows_image_info() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  ensure_test_image
  capture_fn cmd_info
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Image:"
  assert_contains "$TEST_OUTPUT" "isopod-test-workspace"
  _pass
}

test_info_shows_no_image() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  local containers=$(docker ps -q --filter "ancestor=$WORKSPACE_IMAGE" 2>/dev/null)
  if [[ -n "$containers" ]]; then
    docker stop $containers >/dev/null 2>&1 || true
    docker rm $containers >/dev/null 2>&1 || true
  fi
  docker rmi -f "$WORKSPACE_IMAGE" >/dev/null 2>&1 || true
  capture_fn cmd_info
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "not built"
  _pass
}

test_info_shows_all_layers() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_info
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "LAYER"
  assert_contains "$TEST_OUTPUT" "base"
  assert_contains "$TEST_OUTPUT" "system-deps"
  assert_contains "$TEST_OUTPUT" "app"
  _pass
}

# ── Help includes info ──────────────────────────────────────────────────────

test_help_lists_info_command() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_help
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "info"
  assert_contains "$TEST_OUTPUT" "pods, volumes, and cache"
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
