#!/bin/zsh
# tests/test_fresh_db_seed.sh — Fresh DB seed and seed hash tests

source "$(dirname "$0")/test_helper.sh"

# ── cmd_fresh_db_seed (Tests 108–110) ────────────────────────────────────────

test_fresh_db_seed_runs_build_all() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_fresh_db_seed
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Fresh DB Seed"
  assert_contains "$TEST_OUTPUT" "Workspace image built"
  _pass
}

test_fresh_db_seed_no_hook() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_fresh_db_seed
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "No fresh-db-seed hook found"
  _pass
}

test_fresh_db_seed_runs_hook() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs

  local marker="$TEST_TMPDIR/seed_hook_ran"
  cat > "$TEST_DOCKER_DIR/hooks/fresh-db-seed" <<EOF
#!/bin/zsh
touch "$marker"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/fresh-db-seed"

  capture_fn cmd_fresh_db_seed
  assert_exit_code 0
  assert_file_exists "$marker"
  _pass
}

# ── update-seed-hashes hook ─────────────────────────────────────────────────

test_fresh_db_seed_runs_update_seed_hashes_hook() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs

  local marker="$TEST_TMPDIR/seed_hash_hook_ran"
  cat > "$TEST_DOCKER_DIR/hooks/update-seed-hashes" <<EOF
#!/bin/bash
touch "$marker"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/update-seed-hashes"

  capture_fn cmd_fresh_db_seed
  assert_exit_code 0
  assert_file_exists "$marker"
  _pass
}

test_fresh_db_seed_skips_update_seed_hashes_when_no_hook() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # No update-seed-hashes hook — should not error
  capture_fn cmd_fresh_db_seed
  assert_exit_code 0
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
