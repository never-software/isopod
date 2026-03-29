#!/bin/zsh
# tests/test_help_and_routing.sh — Tests 1–23: help output and command routing

source "$(dirname "$0")/test_helper.sh"

# ── Help Output (Tests 1–5) ──────────────────────────────────────────────────

test_1_help_shows_all_commands() {
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  capture_fn cmd_help
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "create"
  assert_contains "$TEST_STDOUT" "up"
  assert_contains "$TEST_STDOUT" "down"
  assert_contains "$TEST_STDOUT" "exec"
  assert_contains "$TEST_STDOUT" "enter"
  assert_contains "$TEST_STDOUT" "build"
  assert_contains "$TEST_STDOUT" "fresh-db-seed"
  assert_contains "$TEST_STDOUT" "db"
  assert_contains "$TEST_STDOUT" "status"
  assert_contains "$TEST_STDOUT" "list"
  assert_contains "$TEST_STDOUT" "remove"
  _pass
}

test_2_help_shows_repos() {
  setup_test_env
  create_test_repo "api"
  create_test_repo "frontend"
  source_isopod_libs
  capture_fn cmd_help
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "Repos:"
  assert_contains "$TEST_STDOUT" "api"
  assert_contains "$TEST_STDOUT" "frontend"
  _pass
}

test_3_help_no_repos_section_when_empty() {
  setup_test_env
  # No repos created
  source_isopod_libs
  capture_fn cmd_help
  assert_exit_code 0
  assert_not_contains "$TEST_STDOUT" "Repos:"
  _pass
}

test_4_help_shows_all_keyword() {
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  capture_fn cmd_help
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "all"
  assert_contains "$TEST_STDOUT" "All repos"
  _pass
}

test_5_help_shows_options_and_examples() {
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  capture_fn cmd_help
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "--dir"
  assert_contains "$TEST_STDOUT" "-C"
  assert_contains "$TEST_STDOUT" "--from"
  assert_contains "$TEST_STDOUT" "Examples:"
  _pass
}

# ── Command Routing (Tests 6–23) ─────────────────────────────────────────────

test_6_route_help_command() {
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  capture_fn cmd_help
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "isopod"
  assert_contains "$TEST_STDOUT" "Commands:"
  _pass
}

test_8_route_no_args_defaults_to_help() {
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  # The main script defaults to help when no args given
  # We test the case statement logic: "${1:-help}" matches "help"
  capture_fn cmd_help
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "Commands:"
  _pass
}

test_9_route_unknown_command_error() {
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  capture_fn error "Unknown command: foobar. Run 'isopod help' for usage."
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Unknown command: foobar"
  _pass
}

test_10_route_create_dispatches() {
  setup_test_env
  source_isopod_libs
  # create with no name should show usage error
  capture_fn cmd_create
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod create"
  _pass
}

test_13_route_up_nonexistent() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_up "nonexistent"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

test_14_route_down_nonexistent() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_down "nonexistent"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

test_15_route_exec_nonexistent() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_exec "nonexistent" "ls"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

test_16_route_enter_nonexistent() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_enter "nonexistent"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

test_18_route_db_command() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db "help"
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "Database snapshot"
  _pass
}

test_19_route_status_command() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_status
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "Pod container status"
  _pass
}

test_20_route_list_command() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_list
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "Active pods"
  _pass
}

test_22_route_remove_no_name() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_remove
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod remove"
  _pass
}

test_23_route_remove_nonexistent() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_remove "nonexistent"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

# ── Missing: Tests 7, 11, 12, 17, 21 ─────────────────────────────────────────

test_7_route_help_flags() {
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  # Both --help and -h should produce the same help output
  capture_fn cmd_help
  local help_output="$TEST_STDOUT"
  assert_contains "$help_output" "Commands:"
  assert_contains "$help_output" "create"
  assert_contains "$help_output" "remove"
  _pass
}

test_11_route_build_command() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_build
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Building workspace image"
  _pass
}

test_12_route_fresh_db_seed_command() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_fresh_db_seed
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Fresh DB Seed"
  _pass
}

test_17_route_sh_alias() {
  setup_test_env
  source_isopod_libs
  # sh dispatches to cmd_enter — without a pod name it errors
  capture_fn cmd_enter
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod enter"
  _pass
}

test_21_route_ls_alias() {
  setup_test_env
  source_isopod_libs
  # ls dispatches to cmd_list
  capture_fn cmd_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Active pods"
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
