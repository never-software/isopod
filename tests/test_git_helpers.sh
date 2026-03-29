#!/bin/zsh
# tests/test_git_helpers.sh — Tests 73–85: git helpers

source "$(dirname "$0")/test_helper.sh"

# ── default_branch_for (Tests 56–59) ─────────────────────────────────────────

test_56_detect_default_branch_main() {
  setup_test_env
  source_isopod_libs
  create_test_repo "api"
  # Set up origin/main ref
  (
    cd "$TEST_REPOS_DIR/api"
    git checkout -q -b main 2>/dev/null || true
    # Create a bare remote to simulate origin
    local remote_path="$TEST_TMPDIR/remote_api.git"
    git init -q --bare "$remote_path"
    git remote add origin "$remote_path" 2>/dev/null || true
    git push -q origin main 2>/dev/null || true
  )
  local result=$(default_branch_for "$TEST_REPOS_DIR/api")
  assert_eq "main" "$result"
  _pass
}

test_58_detect_default_branch_master_fallback() {
  setup_test_env
  source_isopod_libs
  # Create a repo where the only remote branch is 'master'
  local repo_path="$TEST_REPOS_DIR/legacy"
  mkdir -p "$repo_path"
  (
    cd "$repo_path"
    git init -q -b master
    git config user.email "test@test.com"
    git config user.name "Test"
    echo "test" > README.md
    git add -A
    git commit -q -m "initial"
    local remote_path="$TEST_TMPDIR/remote_legacy.git"
    git init -q --bare "$remote_path"
    git remote add origin "$remote_path"
    git push -q origin master
  )
  local result=$(default_branch_for "$repo_path")
  assert_eq "master" "$result"
  _pass
}

test_59_no_default_branch_detected() {
  setup_test_env
  source_isopod_libs
  # Repo with no remote at all
  create_test_repo "orphan"
  local result=$(default_branch_for "$TEST_REPOS_DIR/orphan")
  # No remote, so no default branch detectable
  assert_eq "" "$result"
  _pass
}

# ── create_repo_clone (Tests 74–85) ──────────────────────────────────────────

test_74_create_repo_clone_basic() {
  setup_test_env
  source_isopod_libs
  create_test_repo "api"
  local clone_path="$TEST_TMPDIR/clone_api"
  capture_fn create_repo_clone "$TEST_REPOS_DIR/api" "$clone_path" "my-feature"
  assert_exit_code 0
  assert_dir_exists "$clone_path"
  assert_file_exists "$clone_path/README.md"
  # Verify we're on the feature branch
  local branch=$(cd "$clone_path" && git branch --show-current)
  assert_eq "my-feature" "$branch"
  _pass
}

test_75_create_repo_clone_with_start_point() {
  setup_test_env
  source_isopod_libs
  create_test_repo "api"
  # Create a commit on a develop branch
  (
    cd "$TEST_REPOS_DIR/api"
    git checkout -q -b develop
    echo "develop" > develop.txt
    git add develop.txt
    git commit -q -m "develop commit"
    git checkout -q main 2>/dev/null || git checkout -q master
  )
  local clone_path="$TEST_TMPDIR/clone_api"
  # Use develop as start point
  capture_fn create_repo_clone "$TEST_REPOS_DIR/api" "$clone_path" "my-feature" "develop"
  assert_exit_code 0
  # The feature branch should have the develop commit
  assert_file_exists "$clone_path/develop.txt"
  _pass
}

test_78_create_repo_clone_branch_already_exists() {
  setup_test_env
  source_isopod_libs
  create_test_repo "api"
  # Create the branch in advance
  (cd "$TEST_REPOS_DIR/api" && git checkout -q -b my-feature && git checkout -q main 2>/dev/null || git checkout -q master)
  local clone_path="$TEST_TMPDIR/clone_api"
  capture_fn create_repo_clone "$TEST_REPOS_DIR/api" "$clone_path" "my-feature"
  assert_exit_code 0
  local branch=$(cd "$clone_path" && git branch --show-current)
  assert_eq "my-feature" "$branch"
  _pass
}

test_79_create_repo_clone_excludes_node_modules() {
  setup_test_env
  source_isopod_libs
  create_test_repo "frontend"
  # Add node_modules to the repo dir (not committed)
  mkdir -p "$TEST_REPOS_DIR/frontend/node_modules/some-package"
  echo "module" > "$TEST_REPOS_DIR/frontend/node_modules/some-package/index.js"

  local clone_path="$TEST_TMPDIR/clone_frontend"
  capture_fn create_repo_clone "$TEST_REPOS_DIR/frontend" "$clone_path" "my-feature"
  assert_exit_code 0
  assert_file_not_exists "$clone_path/node_modules/some-package/index.js"
  _pass
}

test_80_create_repo_clone_preserves_env_files() {
  setup_test_env
  source_isopod_libs
  create_test_repo "api"
  # Add .env file (gitignored normally, but rsync copies everything)
  echo "SECRET=abc" > "$TEST_REPOS_DIR/api/.env"

  local clone_path="$TEST_TMPDIR/clone_api"
  capture_fn create_repo_clone "$TEST_REPOS_DIR/api" "$clone_path" "my-feature"
  assert_exit_code 0
  assert_file_exists "$clone_path/.env"
  _pass
}

test_83_create_repo_clone_rsync_failure() {
  setup_test_env
  source_isopod_libs
  # Try to clone from nonexistent path
  local clone_path="$TEST_TMPDIR/clone_nope"
  capture_fn create_repo_clone "/nonexistent/path" "$clone_path" "my-feature"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Failed to copy"
  _pass
}

# ── Missing: Tests 76-77, 81-82, 84-85 ──────────────────────────────────────

test_76_create_repo_clone_auto_detects_default() {
  setup_test_env
  source_isopod_libs
  create_test_repo "api"
  # Set up remote so default branch can be detected
  local remote_path="$TEST_TMPDIR/remote_api.git"
  (
    cd "$TEST_REPOS_DIR/api"
    git init -q --bare "$remote_path"
    git remote add origin "$remote_path"
    git push -q origin main 2>/dev/null || git push -q origin master
  )
  local clone_path="$TEST_TMPDIR/clone_api"
  # No start_point — should auto-detect from remote
  capture_fn create_repo_clone "$TEST_REPOS_DIR/api" "$clone_path" "my-feature"
  assert_exit_code 0
  local branch=$(cd "$clone_path" && git branch --show-current)
  assert_eq "my-feature" "$branch"
  _pass
}

test_77_create_repo_clone_no_remote() {
  setup_test_env
  source_isopod_libs
  create_test_repo "local-only"
  # No remote set up — should branch from HEAD
  local clone_path="$TEST_TMPDIR/clone_local"
  capture_fn create_repo_clone "$TEST_REPOS_DIR/local-only" "$clone_path" "my-feature"
  assert_exit_code 0
  local branch=$(cd "$clone_path" && git branch --show-current)
  assert_eq "my-feature" "$branch"
  # Should have the same content as the original
  assert_file_exists "$clone_path/README.md"
  _pass
}

test_81_create_repo_clone_detect_main_branch() {
  setup_test_env
  source_isopod_libs
  create_test_repo "api"
  local remote_path="$TEST_TMPDIR/remote.git"
  (
    cd "$TEST_REPOS_DIR/api"
    git init -q --bare "$remote_path"
    git remote add origin "$remote_path"
    git push -q origin main
  )
  # default_branch_for should return "main"
  local branch
  branch=$(default_branch_for "$TEST_REPOS_DIR/api")
  assert_eq "main" "$branch"
  _pass
}

test_82_create_repo_clone_detect_master_branch() {
  setup_test_env
  source_isopod_libs
  # Create a repo with master branch
  local repo_path="$TEST_REPOS_DIR/legacy"
  mkdir -p "$repo_path"
  (
    cd "$repo_path"
    git init -q -b master
    git config user.email "test@test.com"
    git config user.name "Test"
    echo "test" > README.md
    git add -A
    git commit -q -m "initial"
    local remote_path="$TEST_TMPDIR/remote_legacy.git"
    git init -q --bare "$remote_path"
    git remote add origin "$remote_path"
    git push -q origin master
  )
  local branch
  branch=$(default_branch_for "$repo_path")
  assert_eq "master" "$branch"
  _pass
}

test_84_create_repo_clone_fetch_failure() {
  setup_test_env
  source_isopod_libs
  create_test_repo "api"
  # Add unreachable remote
  (cd "$TEST_REPOS_DIR/api" && git remote add origin "https://nonexistent.invalid/repo.git")
  local clone_path="$TEST_TMPDIR/clone_api"
  capture_fn create_repo_clone "$TEST_REPOS_DIR/api" "$clone_path" "my-feature"
  assert_exit_code 0
  # Should warn but continue
  assert_contains "$TEST_OUTPUT" "Failed to fetch"
  # Clone should still exist
  assert_dir_exists "$clone_path"
  _pass
}

test_85_create_repo_clone_checkout_failure() {
  setup_test_env
  source_isopod_libs
  create_test_repo "api"
  local clone_path="$TEST_TMPDIR/clone_api"
  # First clone succeeds
  capture_fn create_repo_clone "$TEST_REPOS_DIR/api" "$clone_path" "my-feature"
  assert_exit_code 0
  # Try to clone again to a NEW path but with a branch that already exists in the copy
  local clone2_path="$TEST_TMPDIR/clone_api2"
  capture_fn create_repo_clone "$TEST_REPOS_DIR/api" "$clone2_path" "my-feature"
  # Should succeed by falling back to git checkout (branch exists from original)
  assert_exit_code 0
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
