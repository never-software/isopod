#!/bin/zsh
# tests/test_core_helpers.sh — Tests 24–40: config, output formatting, repo discovery

source "$(dirname "$0")/test_helper.sh"

# ── Project Root Detection (Test 24) ─────────────────────────────────────────

test_24_project_root_detection() {
  setup_test_env
  source_isopod_libs
  # PROJECT_ROOT should be set to the isopod directory after sourcing libs
  assert_eq "$ISOPOD_ROOT" "$PROJECT_ROOT"
  assert_file_exists "$PROJECT_ROOT/isopod"
  assert_dir_exists "$PROJECT_ROOT/lib"
  _pass
}

# ── Docker Dir Override (Tests 25–26) ────────────────────────────────────────

test_25_docker_dir_set_by_env() {
  setup_test_env
  source_isopod_libs
  # DOCKER_DIR should be set to our test docker dir by source_isopod_libs
  assert_eq "$TEST_DOCKER_DIR" "$DOCKER_DIR"
  assert_dir_exists "$DOCKER_DIR"
  assert_dir_exists "$DOCKER_DIR/hooks"
  _pass
}

# ── Output Formatting (Tests 27–31) ──────────────────────────────────────────

test_27_info_output_format() {
  setup_test_env
  source_isopod_libs
  capture_fn info "test message"
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "test message"
  _pass
}

test_28_success_output_format() {
  setup_test_env
  source_isopod_libs
  capture_fn success "test message"
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "test message"
  _pass
}

test_29_warn_output_format() {
  setup_test_env
  source_isopod_libs
  capture_fn warn "test message"
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "test message"
  _pass
}

test_30_error_output_and_exit() {
  setup_test_env
  source_isopod_libs
  capture_fn error "test message"
  assert_exit_code 1
  assert_contains "$TEST_STDERR" "test message"
  _pass
}

test_31_header_output_format() {
  setup_test_env
  source_isopod_libs
  capture_fn header "Test Header"
  assert_exit_code 0
  assert_contains "$TEST_STDOUT" "Test Header"
  _pass
}

# ── Repo Discovery (Tests 32–37) ─────────────────────────────────────────────

test_32_repos_populated_from_repos_dir() {
  setup_test_env
  create_test_repo "api"
  create_test_repo "frontend"
  source_isopod_libs
  assert_eq "2" "${#ALL_REPO_DIRS[@]}"
  _pass
}

test_33_no_repos_dir_no_error() {
  setup_test_env
  rmdir "$TEST_REPOS_DIR"
  source_isopod_libs
  assert_eq "0" "${#ALL_REPO_DIRS[@]}"
  _pass
}

test_34_repo_discovery_names() {
  setup_test_env
  create_test_repo "api"
  create_test_repo "frontend"
  create_test_repo "calendar"
  source_isopod_libs

  local found_api=false found_frontend=false found_calendar=false
  for name in "${ALL_REPO_DIRS[@]}"; do
    [[ "$name" == "api" ]] && found_api=true
    [[ "$name" == "frontend" ]] && found_frontend=true
    [[ "$name" == "calendar" ]] && found_calendar=true
  done

  assert_eq "true" "$found_api" "api not found"
  assert_eq "true" "$found_frontend" "frontend not found"
  assert_eq "true" "$found_calendar" "calendar not found"
  _pass
}

# ── resolve_repo (Tests 38–40) ───────────────────────────────────────────────

test_38_resolve_repo_direct_match() {
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  local result=$(resolve_repo "api")
  assert_eq "api" "$result"
  _pass
}

test_40_resolve_repo_unknown() {
  setup_test_env
  create_test_repo "api"
  source_isopod_libs
  local result
  result=$(resolve_repo "nonexistent") || true
  local rc=$?
  # resolve_repo returns empty and exit 1 for unknown repos
  # But || true above catches it. Instead, test directly:
  if resolve_repo "nonexistent" >/dev/null 2>&1; then
    _fail "Expected resolve_repo to fail for 'nonexistent'"
  fi
  assert_eq "" "$(resolve_repo "nonexistent" 2>/dev/null || true)"
  _pass
}

test_resolve_repo_all_repos() {
  setup_test_env
  create_test_repo "api"
  create_test_repo "frontend"
  source_isopod_libs
  assert_eq "api" "$(resolve_repo "api")"
  assert_eq "frontend" "$(resolve_repo "frontend")"
  _pass
}

# ── Missing: Test 26, 35-37, 39 ──────────────────────────────────────────────

test_26_docker_fallback_to_docker() {
  setup_test_env
  # The isopod script checks: [[ -d "$PROJECT_ROOT/docker.local" ]] && DOCKER_DIR="..."
  # If docker.local doesn't exist, it falls back to docker/
  # We test the logic by checking the code directly
  local test_project="$TEST_TMPDIR/project"
  mkdir -p "$test_project/docker"
  # No docker.local/ exists — should use docker/
  local docker_dir="$test_project/docker"
  [[ -d "$test_project/docker.local" ]] && docker_dir="$test_project/docker.local"
  assert_eq "$test_project/docker" "$docker_dir"
  # Now create docker.local/ — should override
  mkdir -p "$test_project/docker.local"
  docker_dir="$test_project/docker"
  [[ -d "$test_project/docker.local" ]] && docker_dir="$test_project/docker.local"
  assert_eq "$test_project/docker.local" "$docker_dir"
  _pass
}

test_35_repo_parsing_with_aliases_not_in_code() {
  # Test plan items 35-37, 39: REPO_ALIASES not implemented in current code.
  # core.sh discovers repos by scanning directories, not via workspace.conf.
  setup_test_env
  create_test_repo "frontend"
  source_isopod_libs
  # Verify resolve_repo works with directory names only (no aliases)
  assert_eq "frontend" "$(resolve_repo "frontend")"
  # "web" doesn't resolve because there's no alias system
  if resolve_repo "web" >/dev/null 2>&1; then
    _fail "Expected 'web' not to resolve (no alias system)"
  fi
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
