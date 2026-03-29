#!/bin/zsh
# tests/test_db.sh — Tests 188–220: database snapshot management

source "$(dirname "$0")/test_helper.sh"

# ── DB Router (Tests 188–196) ────────────────────────────────────────────────

test_188_db_help() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db "help"
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "Database snapshot"
  assert_contains "$TEST_STDOUT" "save"
  assert_contains "$TEST_STDOUT" "restore"
  assert_contains "$TEST_STDOUT" "list"
  assert_contains "$TEST_STDOUT" "delete"
  _pass
}

test_189_db_no_args_defaults_help() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "Database snapshot"
  _pass
}

test_190_db_unknown_subcommand() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db "foobar"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Unknown db subcommand: foobar"
  _pass
}

test_191_db_router_save() {
  setup_test_env
  source_isopod_libs
  # save with no args should show usage error
  capture_fn cmd_db "save"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod db save"
  _pass
}

test_192_db_router_restore() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db "restore"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod db restore"
  _pass
}

test_193_db_router_list() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db "list"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "No snapshots found"
  _pass
}

test_195_db_router_delete() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db "delete"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod db delete"
  _pass
}

# ── Volume Naming (Tests 197–198) ────────────────────────────────────────────

test_197_data_volume_naming() {
  setup_test_env
  source_isopod_libs
  assert_eq "isopod-test-feat_data" "$(_data_volume "test-feat")"
  _pass
}

test_198_snap_volume_naming() {
  setup_test_env
  source_isopod_libs
  assert_eq "isopod-snap-snap1" "$(_snap_volume "snap1")"
  _pass
}

# ── db save validation (Tests 199–202) ───────────────────────────────────────

test_199_db_save_no_feature_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db_save
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod db save"
  _pass
}

test_200_db_save_no_snapshot_name_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db_save "test-feat"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod db save"
  _pass
}

test_201_db_save_nonexistent_pod_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db_save "nonexistent" "snap1"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

test_202_db_save_container_not_running_error() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  # Container was never started — docker inspect will genuinely fail
  capture_fn cmd_db_save "test-feat" "snap1"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not running"
  _pass
}

# ── db save behavior (Tests 203–206) ─────────────────────────────────────────

test_203_db_save_creates_snapshot() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  capture_fn cmd_db_save "test-feat" "snap1"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Stopping database"
  assert_contains "$TEST_OUTPUT" "Creating snapshot volume"
  assert_contains "$TEST_OUTPUT" "Copying data"
  assert_contains "$TEST_OUTPUT" "Starting database"
  assert_contains "$TEST_OUTPUT" "Snapshot 'snap1' saved"
  # Verify the snapshot volume was created
  assert_volume_exists "isopod-snap-snap1"
  # Clean up snapshot volume
  docker volume rm "isopod-snap-snap1" >/dev/null 2>&1 || true
  _pass
}

test_204_db_save_calls_stop_and_start_hooks() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  capture_fn cmd_db_save "test-feat" "snap1"
  assert_exit_code 0
  # Verify stop/start hooks were called (output shows the flow)
  assert_contains "$TEST_OUTPUT" "Stopping database"
  assert_contains "$TEST_OUTPUT" "Starting database"
  docker volume rm "isopod-snap-snap1" >/dev/null 2>&1 || true
  _pass
}

test_205_db_save_copies_volume() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  capture_fn cmd_db_save "test-feat" "snap1"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Copying data"
  # The snapshot volume should exist (real volume copy happened)
  assert_volume_exists "isopod-snap-snap1"
  docker volume rm "isopod-snap-snap1" >/dev/null 2>&1 || true
  _pass
}

test_206_db_save_overwrite_existing() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  # Pre-create a snapshot volume
  docker volume create "isopod-snap-snap1" >/dev/null 2>&1
  capture_fn cmd_db_save "test-feat" "snap1"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "already exists"
  assert_contains "$TEST_OUTPUT" "overwriting"
  docker volume rm "isopod-snap-snap1" >/dev/null 2>&1 || true
  _pass
}

# ── db restore validation (Tests 207–211) ────────────────────────────────────

test_207_db_restore_no_feature_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db_restore
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod db restore"
  _pass
}

test_208_db_restore_no_snapshot_name_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db_restore "test-feat"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod db restore"
  _pass
}

test_209_db_restore_nonexistent_pod_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db_restore "nonexistent" "snap1"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

test_210_db_restore_container_not_running_error() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  # Container was never started
  capture_fn cmd_db_restore "test-feat" "snap1"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not running"
  _pass
}

test_211_db_restore_snapshot_not_found() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  # No snapshot volume exists — docker volume inspect will fail
  docker volume rm "isopod-snap-snap1" >/dev/null 2>&1 || true
  capture_fn cmd_db_restore "test-feat" "snap1"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

# ── db restore behavior (Test 212) ───────────────────────────────────────────

test_212_db_restore_restores_snapshot() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"
  # Create a snapshot volume to restore from
  docker volume create "isopod-snap-snap1" >/dev/null 2>&1
  capture_fn cmd_db_restore "test-feat" "snap1"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Stopping database"
  assert_contains "$TEST_OUTPUT" "Restoring snapshot"
  assert_contains "$TEST_OUTPUT" "Starting database"
  assert_contains "$TEST_OUTPUT" "Snapshot 'snap1' restored"
  docker volume rm "isopod-snap-snap1" >/dev/null 2>&1 || true
  _pass
}

# ── db list (Tests 213–214) ──────────────────────────────────────────────────

test_213_db_list_no_snapshots() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "No snapshots found"
  _pass
}

test_214_db_list_shows_snapshots() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # Create a real snapshot volume
  docker volume create "isopod-snap-my-snap" >/dev/null 2>&1
  capture_fn cmd_db_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Database snapshots"
  assert_contains "$TEST_OUTPUT" "my-snap"
  docker volume rm "isopod-snap-my-snap" >/dev/null 2>&1 || true
  _pass
}

# ── db delete (Tests 215–217) ────────────────────────────────────────────────

test_215_db_delete_no_name_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db_delete
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod db delete"
  _pass
}

test_216_db_delete_nonexistent_snapshot() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # No volume exists
  docker volume rm "isopod-snap-nonexistent" >/dev/null 2>&1 || true
  capture_fn cmd_db_delete "nonexistent"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

test_217_db_delete_removes_volume() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # Create a real volume to delete
  docker volume create "isopod-snap-snap1" >/dev/null 2>&1
  capture_fn cmd_db_delete "snap1"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "deleted"
  assert_volume_not_exists "isopod-snap-snap1"
  _pass
}

# ── Missing: Tests 194, 196, 218-220 ─────────────────────────────────────────

test_194_db_router_ls_alias() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_db "ls"
  assert_exit_code 0
  # ls alias should dispatch to cmd_db_list — same as "list"
  assert_contains "$TEST_OUTPUT" "No snapshots found"
  _pass
}

test_196_db_router_rm_alias() {
  setup_test_env
  source_isopod_libs
  # rm alias dispatches to cmd_db_delete — no args = usage error
  capture_fn cmd_db "rm"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod db delete"
  _pass
}

test_218_db_stop_uses_hook() {
  setup_test_env
  source_isopod_libs
  # With no hook, _db_stop should warn but not fail
  capture_fn _db_stop "nonexistent-container"
  assert_contains "$TEST_OUTPUT" "No db-stop hook"
  _pass
}

test_219_db_start_uses_hook() {
  setup_test_env
  source_isopod_libs
  # With no hook, _db_start should warn but not fail
  capture_fn _db_start "nonexistent-container"
  assert_contains "$TEST_OUTPUT" "No db-start hook"
  _pass
}

test_220_copy_volume_clears_destination() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # Create source volume with data
  docker volume create "test-src-vol" >/dev/null 2>&1
  docker run --rm -v "test-src-vol:/data" alpine sh -c "echo 'test data' > /data/test.txt" 2>/dev/null
  # Run copy
  capture_fn _copy_volume "test-src-vol" "test-dst-vol"
  assert_exit_code 0
  # Verify destination has the data
  local content=$(docker run --rm -v "test-dst-vol:/data" alpine cat /data/test.txt 2>/dev/null)
  assert_eq "test data" "$content"
  # Cleanup
  docker volume rm "test-src-vol" "test-dst-vol" >/dev/null 2>&1 || true
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
