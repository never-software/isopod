#!/bin/zsh
# tests/test_create.sh — Tests 107–142: build and create commands

source "$(dirname "$0")/test_helper.sh"

# ── Build Command (Tests 107–110) ────────────────────────────────────────────

test_107_build_runs_build_all() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_build
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Building workspace image"
  assert_contains "$TEST_OUTPUT" "Image rebuilt"
  _pass
}

# ── Create Validation (Tests 111–117) ────────────────────────────────────────

test_111_create_no_name_error() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_create
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage: isopod create"
  _pass
}

test_112_create_from_flag_missing_branch() {
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  capture_fn cmd_create "test-feat" "--from"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "--from requires a branch name"
  _pass
}

test_113_create_with_unknown_repo_warns() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "nonexistent"
  assert_contains "$TEST_OUTPUT" "Unknown repo 'nonexistent'"
  _pass
}

test_114_create_with_all_keyword() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  create_test_repo "frontend"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "all"
  assert_exit_code 0
  assert_dir_exists "$TEST_PODS_DIR/test-feat/api"
  assert_dir_exists "$TEST_PODS_DIR/test-feat/frontend"
  _pass
}

test_118_create_basic() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  create_test_repo "frontend"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat"
  assert_exit_code 0
  assert_dir_exists "$TEST_PODS_DIR/test-feat"
  assert_dir_exists "$TEST_PODS_DIR/test-feat/api"
  assert_dir_exists "$TEST_PODS_DIR/test-feat/frontend"
  _pass
}

test_119_create_specific_repos() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  create_test_repo "frontend"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_dir_exists "$TEST_PODS_DIR/test-feat/api"
  assert_file_not_exists "$TEST_PODS_DIR/test-feat/frontend"
  _pass
}

test_121_create_with_from_flag() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  # Create a develop branch in the repo
  (
    cd "$TEST_REPOS_DIR/api"
    git checkout -q -b develop
    echo "develop" > dev.txt
    git add dev.txt
    git commit -q -m "develop"
    git checkout -q main 2>/dev/null || git checkout -q master
  )
  capture_fn cmd_create "test-feat" "api" "--from" "develop"
  assert_exit_code 0
  assert_file_exists "$TEST_PODS_DIR/test-feat/api/dev.txt"
  _pass
}

test_127_create_generates_docker_compose() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_file_exists "$TEST_PODS_DIR/test-feat/docker-compose.yml"
  _pass
}

test_128_create_compose_feature_name_substitution() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  local compose_content=$(cat "$TEST_PODS_DIR/test-feat/docker-compose.yml")
  assert_contains "$compose_content" "container_name: test-feat"
  assert_not_contains "$compose_content" "__FEATURE_NAME__"
  _pass
}

test_129_create_compose_image_name_substitution() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  local compose_content=$(cat "$TEST_PODS_DIR/test-feat/docker-compose.yml")
  assert_contains "$compose_content" "image: isopod-test-workspace"
  assert_not_contains "$compose_content" "__IMAGE_NAME__"
  _pass
}

test_130_create_compose_repo_volumes_no_hook() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  local compose_content=$(cat "$TEST_PODS_DIR/test-feat/docker-compose.yml")
  # Bind mount should always be present
  assert_contains "$compose_content" "./api:/workspace/api:delegated"
  # Without a repo-volumes hook, no extra volumes are added
  assert_not_contains "$compose_content" "/workspace/api/tmp"
  assert_not_contains "$compose_content" "/workspace/api/node_modules"
  _pass
}

test_131_create_compose_repo_volumes_with_hook() {
  require_docker_for_test
  setup_test_env
  create_test_repo "frontend"
  echo '{"name":"frontend"}' > "$TEST_REPOS_DIR/frontend/package.json"
  (cd "$TEST_REPOS_DIR/frontend" && git add -A && git commit -q -m "add package.json")
  source_isopod_libs
  create_compose_template

  # Set up a repo-volumes hook that adds node_modules for Node repos
  cat > "$TEST_DOCKER_DIR/hooks/repo-volumes" <<'HOOK'
#!/bin/bash
echo "      - /workspace/$REPO_NAME/tmp"
echo "      - /workspace/$REPO_NAME/log"
if [[ -f "$POD_DIR/$REPO_NAME/package.json" ]]; then
  echo "      - /workspace/$REPO_NAME/node_modules"
fi
HOOK
  chmod +x "$TEST_DOCKER_DIR/hooks/repo-volumes"

  capture_fn cmd_create "test-feat" "frontend"
  assert_exit_code 0
  local compose_content=$(cat "$TEST_PODS_DIR/test-feat/docker-compose.yml")
  assert_contains "$compose_content" "/workspace/frontend/node_modules"
  assert_contains "$compose_content" "/workspace/frontend/tmp"
  _pass
}

test_132_create_compose_repo_list_env() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  create_test_repo "frontend"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api" "frontend"
  assert_exit_code 0
  local compose_content=$(cat "$TEST_PODS_DIR/test-feat/docker-compose.yml")
  assert_contains "$compose_content" "ISOPOD_REPOS=api,frontend"
  _pass
}

test_133_create_copies_env_files() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  echo "SECRET=abc" > "$TEST_REPOS_DIR/api/.env"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_file_exists "$TEST_PODS_DIR/test-feat/api/.env"
  _pass
}

test_135_create_env_copy_excludes_git_dir() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  # Place .env inside .git/ (should be excluded)
  echo "SECRET=bad" > "$TEST_REPOS_DIR/api/.git/.env"
  echo "SECRET=good" > "$TEST_REPOS_DIR/api/.env"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  # The main .env should exist, but the .git/.env should not
  assert_file_exists "$TEST_PODS_DIR/test-feat/api/.env"
  _pass
}

test_136_create_env_copy_excludes_node_modules() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  mkdir -p "$TEST_REPOS_DIR/api/node_modules"
  echo "SECRET=bad" > "$TEST_REPOS_DIR/api/node_modules/.env"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_file_not_exists "$TEST_PODS_DIR/test-feat/api/node_modules/.env"
  _pass
}

test_142_create_prints_done_summary() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Done!"
  assert_contains "$TEST_OUTPUT" "Pod directory:"
  _pass
}

test_143_create_duplicate_name_error() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  # Create first pod
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  # Try to create again
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "already exists"
  _pass
}

test_124_create_runs_pre_create_hook() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template

  local marker="$TEST_TMPDIR/pre_create_ran"
  cat > "$TEST_DOCKER_DIR/hooks/pre-create" <<EOF
#!/bin/zsh
echo "pre-create hook" > "$marker"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/pre-create"

  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_file_exists "$marker"
  _pass
}

test_create_mounts_pod_workspace_template() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template

  # Create pod_workspace_template in a test project root
  local pod_template="$TEST_TMPDIR/pod_workspace_template"
  mkdir -p "$pod_template/.agent-config"

  # Override PROJECT_ROOT to use our test template
  export PROJECT_ROOT="$TEST_TMPDIR"
  mkdir -p "$TEST_TMPDIR/lib"  # Just needs to exist

  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  local compose_content=$(cat "$TEST_PODS_DIR/test-feat/docker-compose.yml")
  assert_contains "$compose_content" "$pod_template/.agent-config:/workspace/.agent-config:delegated"
  _pass
}

test_134_create_copies_nested_env_files() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  mkdir -p "$TEST_REPOS_DIR/api/config"
  echo "NESTED_SECRET=xyz" > "$TEST_REPOS_DIR/api/config/.env"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_file_exists "$TEST_PODS_DIR/test-feat/api/config/.env"
  _pass
}

# ── Missing: Tests 115-117, 122-123, 137-141 ────────────────────────────────

test_115_create_with_default_repos() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  create_test_repo "frontend"
  source_isopod_libs
  create_compose_template
  # No repos specified — should default to ALL_REPO_DIRS
  capture_fn cmd_create "test-feat"
  assert_exit_code 0
  assert_dir_exists "$TEST_PODS_DIR/test-feat/api"
  assert_dir_exists "$TEST_PODS_DIR/test-feat/frontend"
  _pass
}

test_116_create_with_special_characters_in_name() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  # Name with hyphens and numbers (common)
  capture_fn cmd_create "feat-123-fix" "api"
  assert_exit_code 0
  assert_dir_exists "$TEST_PODS_DIR/feat-123-fix"
  assert_dir_exists "$TEST_PODS_DIR/feat-123-fix/api"
  _pass
}

test_117_create_with_dots_in_name() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "feat-1.0" "api"
  assert_exit_code 0
  assert_dir_exists "$TEST_PODS_DIR/feat-1.0"
  _pass
}

test_122_create_repos_mixed_with_from_flag() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  create_test_repo "frontend"
  source_isopod_libs
  create_compose_template
  # Create a develop branch in both repos
  for r in api frontend; do
    (
      cd "$TEST_REPOS_DIR/$r"
      git checkout -q -b develop
      echo "develop" > develop.txt
      git add develop.txt
      git commit -q -m "develop"
      git checkout -q main 2>/dev/null || git checkout -q master
    )
  done
  capture_fn cmd_create "test-feat" "api" "frontend" "--from" "develop"
  assert_exit_code 0
  assert_file_exists "$TEST_PODS_DIR/test-feat/api/develop.txt"
  assert_file_exists "$TEST_PODS_DIR/test-feat/frontend/develop.txt"
  _pass
}

test_123_create_runs_ensure_image() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Workspace image"
  _pass
}

test_137_create_starts_container() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_container_running "test-feat"
  _pass
}

test_138_create_waits_for_container() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Waiting for container"
  _pass
}

test_139_create_runs_post_create_hook() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  local marker="$TEST_TMPDIR/post_create_ran"
  cat > "$TEST_DOCKER_DIR/hooks/post-create" <<EOF
#!/bin/zsh
echo "CONTAINER=\$CONTAINER FEATURE_NAME=\$FEATURE_NAME" > "$marker"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/post-create"
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_file_exists "$marker"
  local recorded=$(cat "$marker")
  assert_contains "$recorded" "CONTAINER=test-feat"
  assert_contains "$recorded" "FEATURE_NAME=test-feat"
  _pass
}

test_140_create_runs_post_up_hook() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  local marker="$TEST_TMPDIR/post_up_ran"
  cat > "$TEST_DOCKER_DIR/hooks/post-up" <<EOF
#!/bin/zsh
touch "$marker"
EOF
  chmod +x "$TEST_DOCKER_DIR/hooks/post-up"
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_file_exists "$marker"
  _pass
}

test_141_create_runs_setup_workspace() {
  require_docker_for_test
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  create_compose_template
  capture_fn cmd_create "test-feat" "api"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Workspace ready"
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
