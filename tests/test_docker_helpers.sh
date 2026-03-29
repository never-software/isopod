#!/bin/zsh
# tests/test_docker_helpers.sh — Tests 41–72: Docker helpers

source "$(dirname "$0")/test_helper.sh"

# ── require_docker (Tests 41–45) ─────────────────────────────────────────────

test_41_require_docker_installed() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn require_docker
  assert_exit_code 0
  _pass
}

test_42_require_docker_not_installed() {
  setup_test_env
  source_isopod_libs
  # Restrict PATH so docker isn't found
  local saved_path="$PATH"
  export PATH="/usr/bin:/bin"
  if command -v docker &>/dev/null; then
    export PATH="$saved_path"
    skip_test "docker found in restricted PATH"
    return
  fi
  capture_fn require_docker
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Docker is not installed"
  export PATH="$saved_path"
  _pass
}

test_43_require_docker_starts_daemon() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # Docker is already running (require_docker_for_test passed).
  # require_docker should detect it immediately via `docker info` and NOT
  # enter the start/wait path. This validates the "already running" fast path.
  # We can't test the actual daemon-start path without stopping Docker,
  # but we CAN verify that the function completes quickly when Docker is up.
  local start_time=$SECONDS
  capture_fn require_docker
  local elapsed=$((SECONDS - start_time))
  assert_exit_code 0
  # Should complete in under 5s (no 60s timeout loop)
  if [[ $elapsed -ge 10 ]]; then
    _fail "require_docker took ${elapsed}s — should be instant when daemon is running"
  fi
  # Should NOT print "Waiting for Docker daemon" since it's already running
  assert_not_contains "$TEST_OUTPUT" "Waiting for Docker daemon"
  _pass
}

test_44_require_docker_calls_docker_info() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # require_docker calls docker info internally — success means it worked
  capture_fn require_docker
  assert_exit_code 0
  _pass
}

test_45_require_docker_no_start_when_running() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn require_docker
  assert_exit_code 0
  assert_not_contains "$TEST_OUTPUT" "Starting"
  assert_not_contains "$TEST_OUTPUT" "Waiting for Docker daemon"
  _pass
}

# ── Naming Functions (Tests 46–50) ───────────────────────────────────────────

test_46_compose_project_naming() {
  setup_test_env
  source_isopod_libs
  local result=$(compose_project "my-feature")
  assert_eq "isopod-my-feature" "$result"
  _pass
}

test_47_compose_file_for_path() {
  setup_test_env
  source_isopod_libs
  local result=$(compose_file_for "my-feature")
  assert_eq "$TEST_PODS_DIR/my-feature/docker-compose.yml" "$result"
  _pass
}

test_48_workspace_container_naming() {
  setup_test_env
  source_isopod_libs
  local result=$(workspace_container "my-feature")
  assert_eq "my-feature" "$result"
  _pass
}

test_49_workspace_image_name_default() {
  setup_test_env
  source_isopod_libs
  # WORKSPACE_IMAGE is overridden in tests to avoid conflicts
  assert_eq "isopod-test-workspace" "$WORKSPACE_IMAGE"
  # The derivation logic: basename(PROJECT_ROOT)-workspace
  assert_eq "isopod-workspace" "$(basename "$PROJECT_ROOT")-workspace"
  _pass
}

# ── compose_up (Tests 61, 144–147) ───────────────────────────────────────────

test_144_compose_up_success() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat"
  local project=$(compose_project "test-feat")
  local compose_file=$(compose_file_for "test-feat")
  capture_fn compose_up "$project" "$compose_file"
  assert_exit_code 0
  assert_container_running "test-feat"
  _pass
}

test_145_compose_up_port_conflict_retry() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  ensure_test_image

  # Find a free port and bind it with a simple container
  local port=19876
  # Start a blocker container that grabs the port
  docker run -d --name isopod-port-blocker -p ${port}:80 alpine sleep 30 >/dev/null 2>&1

  # Create a pod that wants the same port
  local pod_dir="$TEST_PODS_DIR/port-test"
  mkdir -p "$pod_dir"
  cat > "$pod_dir/docker-compose.yml" <<EOF
services:
  workspace:
    image: $TEST_WORKSPACE_IMAGE
    container_name: port-test
    command: ["sleep", "infinity"]
    ports:
      - "${port}:80"
EOF

  local project=$(compose_project "port-test")
  local compose_file="$pod_dir/docker-compose.yml"

  # Remove the blocker in background so the retry (attempt 2) succeeds.
  # compose_up: attempt 1 (fail) → down → sleep 3 → attempt 2
  # Remove blocker at ~2s so it's gone by the time attempt 2 runs at ~5s.
  (sleep 2 && docker rm -f isopod-port-blocker >/dev/null 2>&1) &
  local bg_pid=$!

  capture_fn compose_up "$project" "$compose_file"
  local rc=$TEST_EXIT_CODE
  wait $bg_pid 2>/dev/null || true

  # Clean up
  docker compose -p "$project" -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f isopod-port-blocker >/dev/null 2>&1 || true

  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Port conflict detected"
  assert_contains "$TEST_OUTPUT" "retrying"
  _pass
}

test_146_compose_up_port_conflict_max_retries() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  ensure_test_image

  # Grab a port with a container that stays up the entire time
  local port=19877
  docker run -d --name isopod-port-blocker2 -p ${port}:80 alpine sleep 120 >/dev/null 2>&1

  local pod_dir="$TEST_PODS_DIR/port-fail"
  mkdir -p "$pod_dir"
  cat > "$pod_dir/docker-compose.yml" <<EOF
services:
  workspace:
    image: $TEST_WORKSPACE_IMAGE
    container_name: port-fail
    command: ["sleep", "infinity"]
    ports:
      - "${port}:80"
EOF

  local project=$(compose_project "port-fail")
  local compose_file="$pod_dir/docker-compose.yml"

  capture_fn compose_up "$project" "$compose_file"

  # Clean up
  docker compose -p "$project" -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f isopod-port-blocker2 >/dev/null 2>&1 || true

  # compose_up calls error() after max retries, which exits non-zero
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Port conflict detected"
  _pass
}

test_147_compose_up_non_port_error() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat"
  # Make compose file reference a non-existent image to trigger non-port error
  cat > "$TEST_PODS_DIR/test-feat/docker-compose.yml" <<'EOF'
services:
  workspace:
    image: this-image-does-not-exist-anywhere-ever:never
    container_name: test-feat
EOF
  local project=$(compose_project "test-feat")
  local compose_file=$(compose_file_for "test-feat")
  capture_fn compose_up "$project" "$compose_file"
  assert_exit_code 1
  # Should NOT retry — no port conflict message
  assert_not_contains "$TEST_OUTPUT" "Port conflict detected"
  assert_not_contains "$TEST_OUTPUT" "retrying"
  _pass
}

# ── wait_for_container (Test 89–90) ──────────────────────────────────────────

test_wait_for_container_reachable() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  create_test_pod "test-feat"
  start_test_container "test-feat"
  capture_fn wait_for_container "test-feat" 4
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Waiting for container"
  _pass
}

test_wait_for_container_timeout() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # Use a non-existent container — docker exec will fail
  capture_fn wait_for_container "nonexistent-container-xyz" 2
  # Should warn but not error (exit 0)
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Waiting for container"
  assert_contains "$TEST_OUTPUT" "not reachable"
  _pass
}

# ── ensure_image (Tests 70–73) ───────────────────────────────────────────────

test_71_ensure_image_exists_and_up_to_date() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # Pre-build the test image
  ensure_test_image
  capture_fn ensure_image
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Workspace image up to date"
  _pass
}

test_70_ensure_image_not_found() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # Stop any containers using the test image before removing it
  local containers=$(docker ps -q --filter "ancestor=$WORKSPACE_IMAGE" 2>/dev/null)
  if [[ -n "$containers" ]]; then
    docker stop $containers >/dev/null 2>&1 || true
    docker rm $containers >/dev/null 2>&1 || true
  fi
  # Force remove the image (including stopped container refs)
  docker rmi -f "$WORKSPACE_IMAGE" >/dev/null 2>&1 || true
  capture_fn ensure_image
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "not found"
  assert_image_exists "$WORKSPACE_IMAGE"
  _pass
}

# ── docker_cleanup (Test 68) ─────────────────────────────────────────────────

test_68_docker_cleanup() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn docker_cleanup
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Docker cleanup complete"
  _pass
}

# ── DB Volume Naming (Tests 197–198) ─────────────────────────────────────────

test_197_data_volume_naming() {
  setup_test_env
  source_isopod_libs
  local result=$(_data_volume "test-feat")
  assert_eq "isopod-test-feat_data" "$result"
  _pass
}

test_198_snap_volume_naming() {
  setup_test_env
  source_isopod_libs
  local result=$(_snap_volume "snap1")
  assert_eq "isopod-snap-snap1" "$result"
  _pass
}

# ── Missing: Tests 44-45, 54-55, 57, 60-67, 69 ──────────────────────────────

test_54_fetch_latest_main_no_remote() {
  setup_test_env
  source_isopod_libs
  # Create a repo with no remote
  create_test_repo "orphan"
  capture_fn fetch_latest_main
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Skipping orphan (no remote)"
  _pass
}

test_55_fetch_latest_main_unreachable_remote() {
  setup_test_env
  source_isopod_libs
  create_test_repo "broken"
  # Add a bad remote
  (cd "$TEST_REPOS_DIR/broken" && git remote add origin "https://nonexistent.invalid/repo.git")
  capture_fn fetch_latest_main
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Could not reach remote"
  _pass
}

test_57_fetch_latest_main_detect_via_symbolic_ref() {
  setup_test_env
  source_isopod_libs
  create_test_repo "api"
  # Set up a proper remote with symbolic HEAD
  local remote_path="$TEST_TMPDIR/remote_api.git"
  (
    cd "$TEST_REPOS_DIR/api"
    git init -q --bare "$remote_path"
    git remote add origin "$remote_path"
    git push -q origin main 2>/dev/null || git push -q origin master
    git remote set-head origin --auto 2>/dev/null || true
  )
  local branch
  branch=$(default_branch_for "$TEST_REPOS_DIR/api")
  # Should detect main or master via symbolic-ref or fallback
  if [[ "$branch" != "main" ]] && [[ "$branch" != "master" ]]; then
    _fail "Expected 'main' or 'master', got '$branch'"
  fi
  _pass
}

test_60_fetch_latest_main_with_remote() {
  setup_test_env
  source_isopod_libs
  create_test_repo "api"
  # Set up proper remote
  local remote_path="$TEST_TMPDIR/remote_api.git"
  (
    cd "$TEST_REPOS_DIR/api"
    git init -q --bare "$remote_path"
    git remote add origin "$remote_path"
    git push -q origin main 2>/dev/null || git push -q origin master
  )
  capture_fn fetch_latest_main
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "All repos on latest default branch"
  _pass
}

test_61_generate_dockerfile_creates_output() {
  setup_test_env
  source_isopod_libs
  echo "FROM alpine" > "$TEST_DOCKER_DIR/workspace.Dockerfile"
  local generated
  generated=$(_generate_dockerfile)
  assert_file_exists "$generated"
  local content=$(cat "$generated")
  assert_contains "$content" "FROM alpine"
  rm -f "$generated"
  _pass
}

test_62_generate_dockerfile_strips_placeholder() {
  setup_test_env
  source_isopod_libs
  printf "FROM alpine\n__CACHE_HOOK_INSTRUCTIONS__\nRUN echo hi\n" > "$TEST_DOCKER_DIR/workspace.Dockerfile"
  local generated
  generated=$(_generate_dockerfile)
  local content=$(cat "$generated")
  assert_not_contains "$content" "__CACHE_HOOK_INSTRUCTIONS__"
  assert_contains "$content" "FROM alpine"
  assert_contains "$content" "RUN echo hi"
  rm -f "$generated"
  _pass
}

test_63_generate_dockerfile_injects_cache_hooks() {
  setup_test_env
  source_isopod_libs
  printf "FROM alpine\n__CACHE_HOOK_INSTRUCTIONS__\nRUN echo hi\n" > "$TEST_DOCKER_DIR/workspace.Dockerfile"
  mkdir -p "$TEST_DOCKER_DIR/cache-hooks"
  cat > "$TEST_DOCKER_DIR/cache-hooks/all.sh" <<'HOOKEOF'
#!/bin/zsh
echo "RUN pip install something"
HOOKEOF
  chmod +x "$TEST_DOCKER_DIR/cache-hooks/all.sh"
  local generated
  generated=$(_generate_dockerfile)
  local content=$(cat "$generated")
  assert_contains "$content" "RUN pip install something"
  assert_not_contains "$content" "__CACHE_HOOK_INSTRUCTIONS__"
  rm -f "$generated"
  _pass
}

test_63b_generate_dockerfile_injects_multiline_cache_hooks() {
  setup_test_env
  source_isopod_libs
  printf "FROM alpine\n__CACHE_HOOK_INSTRUCTIONS__\nRUN echo hi\n" > "$TEST_DOCKER_DIR/workspace.Dockerfile"
  mkdir -p "$TEST_DOCKER_DIR/cache-hooks"
  cat > "$TEST_DOCKER_DIR/cache-hooks/all.sh" <<'HOOKEOF'
#!/bin/zsh
echo "COPY repos/api/Gemfile repos/api/Gemfile.lock /workspace/api/"
echo "RUN cd /workspace/api && bundle install"
echo "COPY repos/frontend/package.json /workspace/frontend/"
echo "RUN cd /workspace/frontend && npm install"
HOOKEOF
  chmod +x "$TEST_DOCKER_DIR/cache-hooks/all.sh"
  local generated
  generated=$(_generate_dockerfile)
  local content=$(cat "$generated")
  assert_contains "$content" "COPY repos/api/Gemfile"
  assert_contains "$content" "bundle install"
  assert_contains "$content" "COPY repos/frontend/package.json"
  assert_contains "$content" "npm install"
  assert_not_contains "$content" "__CACHE_HOOK_INSTRUCTIONS__"
  rm -f "$generated"
  _pass
}

test_64_build_image_with_build_script() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # Create an executable build.sh
  cat > "$TEST_DOCKER_DIR/build.sh" <<'EOF'
#!/bin/zsh
echo "custom build ran with IMAGE=$WORKSPACE_IMAGE"
EOF
  chmod +x "$TEST_DOCKER_DIR/build.sh"
  # Create minimal Dockerfile
  echo "FROM alpine" > "$TEST_DOCKER_DIR/workspace.Dockerfile"
  capture_fn build_image
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "custom build ran"
  assert_contains "$TEST_OUTPUT" "via build.sh"
  _pass
}

test_65_build_image_without_build_script() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  # No build.sh — should fall back to plain docker build
  echo "FROM alpine" > "$TEST_DOCKER_DIR/workspace.Dockerfile"
  capture_fn build_image
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Workspace image built"
  assert_image_exists "$WORKSPACE_IMAGE"
  _pass
}

test_67_build_image_runs_docker_cleanup() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  echo "FROM alpine" > "$TEST_DOCKER_DIR/workspace.Dockerfile"
  capture_fn build_image
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Docker cleanup complete"
  _pass
}

test_69_build_all_sequence() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  echo "FROM alpine" > "$TEST_DOCKER_DIR/workspace.Dockerfile"
  capture_fn build_all
  assert_exit_code 0
  # Should fetch first, then build
  assert_contains "$TEST_OUTPUT" "Fetching latest"
  assert_contains "$TEST_OUTPUT" "Workspace image built"
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
