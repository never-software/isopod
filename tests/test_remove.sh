#!/bin/zsh
# tests/test_remove.sh — Tests 221–238: remove command

source "$(dirname "$0")/test_helper.sh"

# ── remove validation (Tests 221–222) ────────────────────────────────────────

test_221_remove_no_name_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_remove
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod remove"
  _pass
}

test_222_remove_nonexistent_pod_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_remove "nonexistent"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "not found"
  _pass
}

# ── remove behavior — clean pod (Tests 224, 230, 233–236) ────────────────────

test_224_remove_clean_pod_no_prompt() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"

  capture_fn cmd_remove "test-feat" "--force"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Removing pod: test-feat"
  _pass
}

test_230_remove_force_flag_skips_prompt() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"

  # Make changes to the pod repo (uncommitted)
  echo "change" >> "$TEST_PODS_DIR/test-feat/api/README.md"

  capture_fn cmd_remove "test-feat" "--force"
  assert_exit_code 0
  # Should not prompt, should proceed directly
  assert_contains "$TEST_OUTPUT" "Removing pod: test-feat"
  _pass
}

test_231_remove_sets_isopod_removing() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"

  local marker="$TEST_TMPDIR/removing_flag"
  cat > "$TEST_DOCKER_DIR/hooks/teardown-workspace" <<EOF
#!/bin/zsh
echo "ISOPOD_REMOVING=\$ISOPOD_REMOVING" > "$marker"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/teardown-workspace"

  capture_fn cmd_remove "test-feat" "--force"
  assert_exit_code 0
  assert_file_exists "$marker"
  local flag_value=$(cat "$marker")
  assert_contains "$flag_value" "ISOPOD_REMOVING=true"
  _pass
}

test_233_remove_runs_compose_down() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"
  start_test_container "test-feat"

  capture_fn cmd_remove "test-feat" "--force"
  assert_exit_code 0
  # Container should be gone after compose down -v
  assert_container_not_running "test-feat"
  _pass
}

test_234_remove_deletes_pod_directory() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"

  assert_dir_exists "$TEST_PODS_DIR/test-feat"
  capture_fn cmd_remove "test-feat" "--force"
  assert_exit_code 0
  assert_file_not_exists "$TEST_PODS_DIR/test-feat"
  _pass
}

test_235_remove_runs_docker_cleanup() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"

  capture_fn cmd_remove "test-feat" "--force"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Docker cleanup complete"
  _pass
}

test_236_remove_prints_done() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"

  capture_fn cmd_remove "test-feat" "--force"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Done! Pod 'test-feat' fully removed."
  _pass
}

# ── remove safety checks (Tests 225–229) ─────────────────────────────────────

test_225_remove_detects_uncommitted_changes() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"

  # Make uncommitted changes
  echo "dirty" >> "$TEST_PODS_DIR/test-feat/api/README.md"

  # Run without --force but pipe "n" to decline
  capture_fn bash -c "echo n | PODS_DIR='$TEST_PODS_DIR' REPOS_DIR='$TEST_REPOS_DIR' DOCKER_DIR='$TEST_DOCKER_DIR' PROJECT_ROOT='$ISOPOD_ROOT' LIB_DIR='$ISOPOD_ROOT/lib' zsh -c '
    setopt NULL_GLOB
    source \$LIB_DIR/helpers/core.sh
    source \$LIB_DIR/helpers/docker.sh
    WORKSPACE_IMAGE=isopod-test-workspace
    source \$LIB_DIR/helpers/workspace.sh
    source \$LIB_DIR/helpers/git.sh
    source \$LIB_DIR/remove.sh
    cmd_remove test-feat
  '"
  assert_contains "$TEST_OUTPUT" "uncommitted change"
  _pass
}

test_227_remove_detects_local_only_branch() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"

  capture_fn bash -c "echo n | PODS_DIR='$TEST_PODS_DIR' REPOS_DIR='$TEST_REPOS_DIR' DOCKER_DIR='$TEST_DOCKER_DIR' PROJECT_ROOT='$ISOPOD_ROOT' LIB_DIR='$ISOPOD_ROOT/lib' zsh -c '
    setopt NULL_GLOB
    source \$LIB_DIR/helpers/core.sh
    source \$LIB_DIR/helpers/docker.sh
    WORKSPACE_IMAGE=isopod-test-workspace
    source \$LIB_DIR/helpers/workspace.sh
    source \$LIB_DIR/helpers/git.sh
    source \$LIB_DIR/remove.sh
    cmd_remove test-feat
  '"
  assert_contains "$TEST_OUTPUT" "local-only branch"
  _pass
}

test_remove_teardown_hook_runs() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"

  local marker="$TEST_TMPDIR/teardown_ran"
  cat > "$TEST_DOCKER_DIR/hooks/teardown-workspace" <<EOF
#!/bin/zsh
touch "$marker"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/teardown-workspace"

  capture_fn cmd_remove "test-feat" "--force"
  assert_exit_code 0
  assert_file_exists "$marker"
  _pass
}

test_remove_compose_down_failure_warns() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"

  # Make compose file invalid so compose down fails
  echo "invalid yaml {{{" > "$TEST_PODS_DIR/test-feat/docker-compose.yml"
  capture_fn cmd_remove "test-feat" "--force"
  assert_exit_code 0
  # Should warn but continue
  assert_contains "$TEST_OUTPUT" "Failed to remove container"
  assert_file_not_exists "$TEST_PODS_DIR/test-feat"
  _pass
}

# ── Missing: Tests 226, 228-229, 232, 237-238 ────────────────────────────────

test_226_remove_with_unpushed_commits() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"
  # Make a commit in the pod (unpushed, no remote tracking)
  (
    cd "$TEST_PODS_DIR/test-feat/api"
    echo "new" > new_file.txt
    git add new_file.txt
    git commit -q -m "unpushed commit"
  )
  # Run remove, pipe "n" to decline
  capture_fn bash -c "echo n | PODS_DIR='$TEST_PODS_DIR' REPOS_DIR='$TEST_REPOS_DIR' DOCKER_DIR='$TEST_DOCKER_DIR' PROJECT_ROOT='$ISOPOD_ROOT' LIB_DIR='$ISOPOD_ROOT/lib' zsh -c '
    setopt NULL_GLOB
    source \$LIB_DIR/helpers/core.sh
    source \$LIB_DIR/helpers/docker.sh
    WORKSPACE_IMAGE=isopod-test-workspace
    source \$LIB_DIR/helpers/workspace.sh
    source \$LIB_DIR/helpers/git.sh
    source \$LIB_DIR/remove.sh
    cmd_remove test-feat
  '"
  # Should warn about local-only branch (which implies unpushed)
  assert_contains "$TEST_OUTPUT" "local-only branch"
  _pass
}

test_228_remove_prompt_declined() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"
  # Make dirty state
  echo "dirty" >> "$TEST_PODS_DIR/test-feat/api/README.md"
  # Pipe "n" to decline removal
  capture_fn bash -c "echo n | PODS_DIR='$TEST_PODS_DIR' REPOS_DIR='$TEST_REPOS_DIR' DOCKER_DIR='$TEST_DOCKER_DIR' PROJECT_ROOT='$ISOPOD_ROOT' LIB_DIR='$ISOPOD_ROOT/lib' zsh -c '
    setopt NULL_GLOB
    source \$LIB_DIR/helpers/core.sh
    source \$LIB_DIR/helpers/docker.sh
    WORKSPACE_IMAGE=isopod-test-workspace
    source \$LIB_DIR/helpers/workspace.sh
    source \$LIB_DIR/helpers/git.sh
    source \$LIB_DIR/remove.sh
    cmd_remove test-feat
  '"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Aborted"
  # Pod should still exist
  assert_dir_exists "$TEST_PODS_DIR/test-feat"
  _pass
}

test_229_remove_prompt_accepted() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"
  echo "dirty" >> "$TEST_PODS_DIR/test-feat/api/README.md"
  # Pipe "y" to accept removal
  capture_fn bash -c "echo y | PODS_DIR='$TEST_PODS_DIR' REPOS_DIR='$TEST_REPOS_DIR' DOCKER_DIR='$TEST_DOCKER_DIR' PROJECT_ROOT='$ISOPOD_ROOT' LIB_DIR='$ISOPOD_ROOT/lib' zsh -c '
    setopt NULL_GLOB
    source \$LIB_DIR/helpers/core.sh
    source \$LIB_DIR/helpers/docker.sh
    WORKSPACE_IMAGE=isopod-test-workspace
    source \$LIB_DIR/helpers/workspace.sh
    source \$LIB_DIR/helpers/git.sh
    source \$LIB_DIR/remove.sh
    source \$LIB_DIR/cache.sh
    cmd_remove test-feat
  '"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Removing pod"
  assert_file_not_exists "$TEST_PODS_DIR/test-feat"
  _pass
}

test_232_teardown_hook_receives_isopod_removing() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"
  local marker="$TEST_TMPDIR/removing_val"
  cat > "$TEST_DOCKER_DIR/hooks/teardown-workspace" <<EOF
#!/bin/zsh
echo "\$ISOPOD_REMOVING" > "$marker"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/teardown-workspace"
  capture_fn cmd_remove "test-feat" "--force"
  assert_exit_code 0
  assert_file_exists "$marker"
  local val=$(cat "$marker")
  assert_eq "true" "$val"
  _pass
}

test_237_remove_safety_check_multiple_repos() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  create_test_repo "frontend"
  source_isopod_libs
  create_test_pod "test-feat" "api" "frontend"
  # Make changes in both repos
  echo "dirty" >> "$TEST_PODS_DIR/test-feat/api/README.md"
  echo "dirty" >> "$TEST_PODS_DIR/test-feat/frontend/README.md"
  capture_fn bash -c "echo n | PODS_DIR='$TEST_PODS_DIR' REPOS_DIR='$TEST_REPOS_DIR' DOCKER_DIR='$TEST_DOCKER_DIR' PROJECT_ROOT='$ISOPOD_ROOT' LIB_DIR='$ISOPOD_ROOT/lib' zsh -c '
    setopt NULL_GLOB
    source \$LIB_DIR/helpers/core.sh
    source \$LIB_DIR/helpers/docker.sh
    WORKSPACE_IMAGE=isopod-test-workspace
    source \$LIB_DIR/helpers/workspace.sh
    source \$LIB_DIR/helpers/git.sh
    source \$LIB_DIR/remove.sh
    cmd_remove test-feat
  '"
  # Should warn about both repos independently
  assert_contains "$TEST_OUTPUT" "api"
  assert_contains "$TEST_OUTPUT" "frontend"
  assert_contains "$TEST_OUTPUT" "uncommitted"
  _pass
}

test_238_remove_safety_check_multiple_branches() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_test_pod "test-feat" "api"
  # Create an additional local branch in the pod
  (
    cd "$TEST_PODS_DIR/test-feat/api"
    git checkout -q -b extra-branch
    echo "extra" > extra.txt
    git add extra.txt
    git commit -q -m "extra"
    git checkout -q test-feat
  )
  capture_fn bash -c "echo n | PODS_DIR='$TEST_PODS_DIR' REPOS_DIR='$TEST_REPOS_DIR' DOCKER_DIR='$TEST_DOCKER_DIR' PROJECT_ROOT='$ISOPOD_ROOT' LIB_DIR='$ISOPOD_ROOT/lib' zsh -c '
    setopt NULL_GLOB
    source \$LIB_DIR/helpers/core.sh
    source \$LIB_DIR/helpers/docker.sh
    WORKSPACE_IMAGE=isopod-test-workspace
    source \$LIB_DIR/helpers/workspace.sh
    source \$LIB_DIR/helpers/git.sh
    source \$LIB_DIR/remove.sh
    cmd_remove test-feat
  '"
  # Should warn about both branches
  assert_contains "$TEST_OUTPUT" "local-only branch"
  assert_contains "$TEST_OUTPUT" "extra-branch"
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
