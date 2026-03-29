#!/bin/zsh
# tests/test_helper.sh — Lightweight test framework for isopod
#
# Provides: setup/teardown, assertions, test runner per file.
# Tests use REAL Docker — no mocks. Tests that require Docker will skip
# if Docker is not available.

set +e  # Don't exit on error — we need to capture failures

# ── Globals ──────────────────────────────────────────────────────────────────
ISOPOD_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0
FAILED_TESTS=()
CURRENT_TEST=""

# Test workspace image — avoids conflicts with real isopod installations
TEST_WORKSPACE_IMAGE="isopod-test-workspace"

# ── Colors (minimal, for test output) ─────────────────────────────────────────
_RED='\033[0;31m'
_GREEN='\033[0;32m'
_YELLOW='\033[0;33m'
_CYAN='\033[0;36m'
_BOLD='\033[1m'
_DIM='\033[2m'
_NC='\033[0m'

# ── Test Environment Setup ────────────────────────────────────────────────────

setup_test_env() {
  TEST_TMPDIR=$(mktemp -d)

  # Create isolated directory structure
  export TEST_REPOS_DIR="$TEST_TMPDIR/repos"
  export TEST_PODS_DIR="$TEST_TMPDIR/pods"
  export TEST_DOCKER_DIR="$TEST_TMPDIR/docker"
  mkdir -p "$TEST_REPOS_DIR" "$TEST_PODS_DIR" "$TEST_DOCKER_DIR"
  mkdir -p "$TEST_DOCKER_DIR/hooks" "$TEST_DOCKER_DIR/cache-hooks"

  # Create a minimal test Dockerfile with layer markers
  cat > "$TEST_DOCKER_DIR/workspace.Dockerfile" <<'DOCKERFILE'
# layer: base
FROM alpine:latest
# layer: system-deps
RUN apk add --no-cache bash git
# layer: app
RUN mkdir -p /workspace
CMD ["sleep", "infinity"]
DOCKERFILE
}

teardown_test_env() {
  setopt NULL_GLOB 2>/dev/null || true
  # Clean up any Docker containers started during the test
  if [[ -d "${TEST_PODS_DIR:-}" ]]; then
    for pod_dir in "$TEST_PODS_DIR"/*/; do
      [[ -d "$pod_dir" ]] || continue
      local pod_name=$(basename "$pod_dir")
      local compose_file="$pod_dir/docker-compose.yml"
      if [[ -f "$compose_file" ]]; then
        docker compose -p "isopod-${pod_name}" -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || true
      fi
    done
  fi

  if [[ -n "${TEST_TMPDIR:-}" ]] && [[ -d "$TEST_TMPDIR" ]]; then
    rm -rf "$TEST_TMPDIR"
  fi
}

# ── Docker Helpers ───────────────────────────────────────────────────────────

# Skip test if Docker is not available
require_docker_for_test() {
  if ! docker info &>/dev/null 2>&1; then
    skip_test "Docker not available"
  fi
}

# Build the test workspace image if it doesn't exist (cached by Docker)
ensure_test_image() {
  if ! docker image inspect "$TEST_WORKSPACE_IMAGE" &>/dev/null 2>&1; then
    docker build -t "$TEST_WORKSPACE_IMAGE" - <<'DOCKERFILE' 2>/dev/null
FROM alpine:latest
RUN apk add --no-cache bash git
RUN mkdir -p /workspace
CMD ["sleep", "infinity"]
DOCKERFILE
  fi
}

# Start a real container for a test pod
start_test_container() {
  local name="$1"
  local compose_file="$TEST_PODS_DIR/$name/docker-compose.yml"
  [[ -f "$compose_file" ]] || return 1
  ensure_test_image
  docker compose -p "isopod-${name}" -f "$compose_file" up -d >/dev/null 2>&1
  # Wait for container to be ready
  for ((t=0; t<20; t++)); do
    docker exec "$name" true &>/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

# Stop and remove a test container
stop_test_container() {
  local name="$1"
  local compose_file="$TEST_PODS_DIR/$name/docker-compose.yml"
  [[ -f "$compose_file" ]] || return 0
  docker compose -p "isopod-${name}" -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || true
}

# ── Test Repos ────────────────────────────────────────────────────────────────

# Create a minimal git repo in the test repos dir
create_test_repo() {
  local name="$1"
  local repo_path="$TEST_REPOS_DIR/$name"
  mkdir -p "$repo_path"
  (
    cd "$repo_path"
    git init -q
    git config user.email "test@test.com"
    git config user.name "Test"
    echo "test" > README.md
    git add -A
    git commit -q -m "initial"
  )
}

# Create a test pod directory with a real Docker compose file
create_test_pod() {
  local name="$1"
  shift
  local repos=("$@")
  local pod_dir="$TEST_PODS_DIR/$name"
  mkdir -p "$pod_dir"

  for repo in "${repos[@]}"; do
    mkdir -p "$pod_dir/$repo"
    (
      cd "$pod_dir/$repo"
      git init -q
      git config user.email "test@test.com"
      git config user.name "Test"
      echo "test" > README.md
      git add -A
      git commit -q -m "initial"
      git checkout -q -b "$name" 2>/dev/null || true
    )
  done

  # Create a docker-compose.yml with the test workspace image
  cat > "$pod_dir/docker-compose.yml" <<EOF
services:
  workspace:
    image: $TEST_WORKSPACE_IMAGE
    container_name: $name
    command: ["sleep", "infinity"]
    volumes:
      - data:/data
volumes:
  data:
EOF
}

# Create a minimal docker-compose template
create_compose_template() {
  cat > "$TEST_DOCKER_DIR/docker-compose.template.yml" <<'EOF'
services:
  workspace:
    image: __IMAGE_NAME__
    container_name: __FEATURE_NAME__
    hostname: __FEATURE_NAME__
    environment:
      - ISOPOD_REPOS=__REPO_LIST__
    volumes:
      - pgdata:/pgdata
__REPO_VOLUMES__
volumes:
  pgdata:
EOF
}

# ── Source Isopod Libraries ───────────────────────────────────────────────────

# Source isopod libs with test environment
# Call after setup_test_env and creating repos
source_isopod_libs() {
  export PROJECT_ROOT="$ISOPOD_ROOT"
  export REPOS_DIR="$TEST_REPOS_DIR"
  export PODS_DIR="$TEST_PODS_DIR"
  export DOCKER_DIR="$TEST_DOCKER_DIR"
  export LIB_DIR="$ISOPOD_ROOT/lib"

  # Suppress zsh "no matches found" for empty glob in core.sh
  setopt NULL_GLOB 2>/dev/null || true
  source "$LIB_DIR/helpers/core.sh"
  source "$LIB_DIR/helpers/docker.sh"
  source "$LIB_DIR/helpers/workspace.sh"
  source "$LIB_DIR/helpers/git.sh"
  source "$LIB_DIR/helpers/layers.sh"

  # Override workspace image to avoid conflicts with real installations
  export WORKSPACE_IMAGE="$TEST_WORKSPACE_IMAGE"

  source "$LIB_DIR/build.sh"
  source "$LIB_DIR/create.sh"
  source "$LIB_DIR/up.sh"
  source "$LIB_DIR/down.sh"
  source "$LIB_DIR/exec.sh"
  source "$LIB_DIR/enter.sh"
  source "$LIB_DIR/fresh_db_seed.sh"
  source "$LIB_DIR/status.sh"
  source "$LIB_DIR/list.sh"
  source "$LIB_DIR/remove.sh"
  source "$LIB_DIR/db.sh"
  source "$LIB_DIR/cache.sh"
  source "$LIB_DIR/info.sh"
  source "$LIB_DIR/help.sh"
}

# ── Capture Command Output ───────────────────────────────────────────────────

# Run a command and capture stdout, stderr, and exit code.
# Sets: TEST_STDOUT, TEST_STDERR, TEST_OUTPUT, TEST_EXIT_CODE
capture() {
  local stdout_file="$TEST_TMPDIR/.capture_stdout"
  local stderr_file="$TEST_TMPDIR/.capture_stderr"

  "$@" >"$stdout_file" 2>"$stderr_file"
  TEST_EXIT_CODE=$?

  TEST_STDOUT=$(cat "$stdout_file")
  TEST_STDERR=$(cat "$stderr_file")
  TEST_OUTPUT="${TEST_STDOUT}${TEST_STDERR}"
}

# Run a shell function in a subshell (catches exit from error())
capture_fn() {
  local stdout_file="$TEST_TMPDIR/.capture_stdout"
  local stderr_file="$TEST_TMPDIR/.capture_stderr"

  (
    "$@"
  ) >"$stdout_file" 2>"$stderr_file"
  TEST_EXIT_CODE=$?

  TEST_STDOUT=$(cat "$stdout_file")
  TEST_STDERR=$(cat "$stderr_file")
  TEST_OUTPUT="${TEST_STDOUT}${TEST_STDERR}"
}

# ── Assertions ────────────────────────────────────────────────────────────────
# _fail exits the subshell immediately so subsequent assertions are skipped.

_fail() {
  printf "  ${_RED}FAIL${_NC} %s\n" "$CURRENT_TEST"
  printf "       ${_DIM}%b${_NC}\n" "$1"
  exit 1
}

_pass() {
  printf "  ${_GREEN}PASS${_NC} %s\n" "$CURRENT_TEST"
  exit 0
}

assert_eq() {
  local expected="$1" actual="$2" msg="${3:-}"
  if [[ "$expected" != "$actual" ]]; then
    _fail "Expected: '$expected'\n       Got:      '$actual'${msg:+\n       $msg}"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if [[ "$haystack" != *"$needle"* ]]; then
    _fail "Expected output to contain: '$needle'${msg:+\n       $msg}\n       Got: '${haystack:0:200}'"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if [[ "$haystack" == *"$needle"* ]]; then
    _fail "Expected output NOT to contain: '$needle'${msg:+\n       $msg}"
  fi
}

assert_match() {
  local string="$1" pattern="$2" msg="${3:-}"
  if [[ ! "$string" =~ $pattern ]]; then
    _fail "Expected to match pattern: '$pattern'${msg:+\n       $msg}\n       Got: '${string:0:200}'"
  fi
}

assert_exit_code() {
  local expected="$1" msg="${2:-}"
  if [[ "$TEST_EXIT_CODE" != "$expected" ]]; then
    _fail "Expected exit code $expected, got $TEST_EXIT_CODE${msg:+\n       $msg}"
  fi
}

assert_file_exists() {
  local path="$1"
  if [[ ! -e "$path" ]]; then
    _fail "Expected file to exist: $path"
  fi
}

assert_file_not_exists() {
  local path="$1"
  if [[ -e "$path" ]]; then
    _fail "Expected file NOT to exist: $path"
  fi
}

assert_dir_exists() {
  local path="$1"
  if [[ ! -d "$path" ]]; then
    _fail "Expected directory to exist: $path"
  fi
}

# ── Docker Assertions ────────────────────────────────────────────────────────

assert_container_running() {
  local name="$1"
  local running=$(docker inspect --type=container --format='{{.State.Running}}' "$name" 2>/dev/null)
  if [[ "$running" != "true" ]]; then
    _fail "Expected container '$name' to be running"
  fi
}

assert_container_not_running() {
  local name="$1"
  local running=$(docker inspect --type=container --format='{{.State.Running}}' "$name" 2>/dev/null)
  if [[ "$running" == "true" ]]; then
    _fail "Expected container '$name' to NOT be running"
  fi
}

assert_image_exists() {
  local name="$1"
  if ! docker image inspect "$name" &>/dev/null 2>&1; then
    _fail "Expected image '$name' to exist"
  fi
}

assert_image_not_exists() {
  local name="$1"
  if docker image inspect "$name" &>/dev/null 2>&1; then
    _fail "Expected image '$name' to NOT exist"
  fi
}

assert_volume_exists() {
  local name="$1"
  if ! docker volume inspect "$name" &>/dev/null 2>&1; then
    _fail "Expected volume '$name' to exist"
  fi
}

assert_volume_not_exists() {
  local name="$1"
  if docker volume inspect "$name" &>/dev/null 2>&1; then
    _fail "Expected volume '$name' to NOT exist"
  fi
}

# ── Skip ──────────────────────────────────────────────────────────────────────

skip_test() {
  local reason="${1:-}"
  printf "  ${_YELLOW}SKIP${_NC} %s${reason:+ — $reason}\n" "$CURRENT_TEST"
  exit 0
}

# ── Test Runner ───────────────────────────────────────────────────────────────

# Run all test_* functions in the calling script.
# Each test runs in a subshell — _pass/_fail exit that subshell.
# The runner parses stdout to count results.
run_test_file() {
  local file_name="${1:-$(basename "$0")}"
  local filter="${TEST_FILTER:-}"

  printf "\n${_BOLD}${_CYAN}%s${_NC}\n" "$file_name"

  # Discover all test_ functions
  local test_fns=($(typeset +f | grep '^test_' | sort))

  for fn in "${test_fns[@]}"; do
    # Apply filter if set
    if [[ -n "$filter" ]] && [[ "$fn" != *"$filter"* ]]; then
      continue
    fi

    CURRENT_TEST="$fn"

    # Run test in subshell with automatic teardown via trap
    local _test_out_file=$(mktemp)
    (
      trap 'teardown_test_env' EXIT
      $fn
    ) > "$_test_out_file" 2>&1
    local result=$?
    local test_output=""
    test_output="$(<"$_test_out_file")"
    rm -f "$_test_out_file"

    # Determine outcome from the output
    if echo "$test_output" | grep -q "PASS"; then
      TESTS_PASSED=$((TESTS_PASSED + 1))
      echo "$test_output"
    elif echo "$test_output" | grep -q "SKIP"; then
      TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
      echo "$test_output"
    elif echo "$test_output" | grep -q "FAIL"; then
      TESTS_FAILED=$((TESTS_FAILED + 1))
      FAILED_TESTS+=("$fn")
      echo "$test_output"
    else
      # No PASS/FAIL/SKIP marker — unexpected error
      TESTS_FAILED=$((TESTS_FAILED + 1))
      FAILED_TESTS+=("$fn")
      printf "  ${_RED}FAIL${_NC} %s\n" "$fn"
      printf "       ${_DIM}Unexpected error (exit $result)${_NC}\n"
      [[ -n "$test_output" ]] && printf "       ${_DIM}%s${_NC}\n" "${test_output:0:300}"
    fi
  done
}

# Print summary and exit with appropriate code
print_summary() {
  local total=$((TESTS_PASSED + TESTS_FAILED + TESTS_SKIPPED))
  echo ""
  printf "${_BOLD}Results:${_NC} "
  printf "${_GREEN}%d passed${_NC}, " "$TESTS_PASSED"
  printf "${_RED}%d failed${_NC}, " "$TESTS_FAILED"
  printf "${_YELLOW}%d skipped${_NC}" "$TESTS_SKIPPED"
  printf " (${_BOLD}%d total${_NC})\n" "$total"

  if [[ ${#FAILED_TESTS[@]} -gt 0 ]]; then
    echo ""
    printf "${_RED}Failed tests:${_NC}\n"
    for t in "${FAILED_TESTS[@]}"; do
      printf "  ${_RED}-${_NC} %s\n" "$t"
    done
  fi

  echo ""
  [[ $TESTS_FAILED -eq 0 ]]
}
