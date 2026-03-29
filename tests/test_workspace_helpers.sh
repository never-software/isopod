#!/bin/zsh
# tests/test_workspace_helpers.sh — Tests 86–106: workspace lifecycle hooks

source "$(dirname "$0")/test_helper.sh"

# ── setup_workspace (Tests 86–89) ────────────────────────────────────────────

test_88_setup_workspace_runs_post_workspace_hook() {
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"

  # Create an executable post-workspace hook
  cat > "$TEST_DOCKER_DIR/hooks/post-workspace" <<'EOF'
#!/bin/zsh
echo "post-workspace hook ran with POD_DIR=$POD_DIR FEATURE_NAME=$FEATURE_NAME"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/post-workspace"

  capture_fn setup_workspace "$TEST_PODS_DIR/test-feat"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "post-workspace hook ran"
  assert_contains "$TEST_OUTPUT" "FEATURE_NAME=test-feat"
  assert_contains "$TEST_OUTPUT" "Workspace ready"
  _pass
}

test_89_setup_workspace_skips_missing_hook() {
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat" "api"

  # No post-workspace hook exists
  capture_fn setup_workspace "$TEST_PODS_DIR/test-feat"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Workspace ready"
  _pass
}

# ── teardown_workspace (Tests 90–92) ─────────────────────────────────────────

test_90_teardown_workspace_runs_hook() {
  setup_test_env
  source_isopod_libs

  # Create an executable teardown hook
  cat > "$TEST_DOCKER_DIR/hooks/teardown-workspace" <<'EOF'
#!/bin/zsh
echo "teardown hook ran with FEATURE_NAME=$FEATURE_NAME"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/teardown-workspace"

  capture_fn teardown_workspace "test-feat"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "teardown hook ran"
  assert_contains "$TEST_OUTPUT" "FEATURE_NAME=test-feat"
  _pass
}

test_91_teardown_workspace_missing_hook() {
  setup_test_env
  source_isopod_libs

  # No teardown hook exists
  capture_fn teardown_workspace "test-feat"
  assert_exit_code 0
  # Should produce no hook-related output
  assert_not_contains "$TEST_OUTPUT" "teardown hook ran"
  assert_not_contains "$TEST_OUTPUT" "FEATURE_NAME"
  _pass
}

test_92_teardown_workspace_hook_failure_ignored() {
  setup_test_env
  source_isopod_libs

  # Create a hook that fails
  cat > "$TEST_DOCKER_DIR/hooks/teardown-workspace" <<'EOF'
#!/bin/zsh
exit 1
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/teardown-workspace"

  capture_fn teardown_workspace "test-feat"
  # Should succeed despite hook failure (|| true)
  assert_exit_code 0
  _pass
}

test_setup_workspace_hook_receives_pod_dir() {
  setup_test_env
  source_isopod_libs
  create_test_pod "my-pod" "api"

  local marker="$TEST_TMPDIR/hook_marker"
  cat > "$TEST_DOCKER_DIR/hooks/post-workspace" <<EOF
#!/bin/zsh
echo "\$POD_DIR" > "$marker"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/post-workspace"

  capture_fn setup_workspace "$TEST_PODS_DIR/my-pod"
  assert_file_exists "$marker"
  local recorded=$(cat "$marker")
  assert_contains "$recorded" "my-pod"
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
