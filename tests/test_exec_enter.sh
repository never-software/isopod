#!/bin/zsh
# tests/test_exec_enter.sh — Tests 148–161: exec and enter commands

source "$(dirname "$0")/test_helper.sh"

# ── exec validation (Tests 148–151) ──────────────────────────────────────────

test_148_exec_no_name_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_exec
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod exec"
  _pass
}

test_149_exec_no_command_error() {
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  capture_fn cmd_exec "test-feat"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "No command specified"
  _pass
}

test_150_exec_nonexistent_pod_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_exec "nonexistent" "ls"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

test_151_exec_container_not_running_error() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  # Container was never started — docker inspect will genuinely fail
  capture_fn cmd_exec "test-feat" "ls"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not running"
  _pass
}

# ── exec behavior (Tests 152–157) ────────────────────────────────────────────

test_152_exec_basic_command() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  # Run a real command inside the container
  capture_fn cmd_exec "test-feat" "echo" "hello"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "hello"
  _pass
}

test_153_exec_with_dir_flag() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  capture_fn cmd_exec "test-feat" "--dir" "/" "pwd"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "/"
  _pass
}

test_154_exec_default_workdir() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  capture_fn cmd_exec "test-feat" "pwd"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "/workspace"
  _pass
}

test_156_exec_propagates_exit_code() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  # Run a command that exits with a specific code
  capture_fn cmd_exec "test-feat" "sh" "-c" "exit 42"
  assert_exit_code 42
  _pass
}

# ── enter validation (Tests 158–161) ─────────────────────────────────────────

test_158_enter_no_name_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_enter
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod enter"
  _pass
}

test_159_enter_nonexistent_pod_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_enter "nonexistent"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

test_160_enter_container_not_running_error() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  # Container was never started — docker inspect will genuinely fail
  capture_fn cmd_enter "test-feat"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not running"
  _pass
}

# ── Missing: Tests 145-146, 155, 157, 161 ────────────────────────────────────

test_155_exec_tty_detection() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  # When stdin is not a TTY (piped), should use -i only, not -it
  # We verify the command runs successfully in non-TTY mode
  capture_fn cmd_exec "test-feat" "echo" "hi"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "hi"
  _pass
}

test_157_exec_multi_word_command() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  capture_fn cmd_exec "test-feat" "sh" "-c" "echo hello world"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "hello world"
  _pass
}

test_161_enter_opens_interactive_shell() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  # cmd_enter uses exec docker exec -it — in non-TTY test env, docker
  # will complain about TTY but should get past validation
  capture_fn cmd_enter "test-feat"
  # Should not show validation errors — it got to the docker exec call
  assert_not_contains "$TEST_OUTPUT" "not found"
  assert_not_contains "$TEST_OUTPUT" "not running"
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
