#!/bin/zsh
# tests/test_cache.sh — Cache command tests

source "$(dirname "$0")/test_helper.sh"

# ── cache router ─────────────────────────────────────────────────────────────

test_cache_defaults_to_list() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_cache
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Cache layers"
  _pass
}

test_cache_help() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_cache "help"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Manage build cache"
  assert_contains "$TEST_OUTPUT" "list"
  assert_contains "$TEST_OUTPUT" "rebuild"
  assert_contains "$TEST_OUTPUT" "delete"
  assert_contains "$TEST_OUTPUT" "destroy"
  _pass
}

test_cache_unknown_subcommand() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_cache "foobar"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Unknown cache subcommand: foobar"
  _pass
}

# ── cache list ───────────────────────────────────────────────────────────────

test_cache_list_shows_layers() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  capture_fn cmd_cache_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Cache layers"
  assert_contains "$TEST_OUTPUT" "LAYER"
  assert_contains "$TEST_OUTPUT" "base"
  assert_contains "$TEST_OUTPUT" "system-deps"
  assert_contains "$TEST_OUTPUT" "app"
  _pass
}

test_cache_list_parses_from_dockerfile() {
  setup_test_env
  # Write a custom Dockerfile with different layers
  cat > "$TEST_DOCKER_DIR/workspace.Dockerfile" <<'EOF'
# layer: foundation
FROM alpine:latest
# layer: tools
RUN apk add --no-cache bash
# layer: runtime
CMD ["sleep", "infinity"]
EOF
  source_isopod_libs
  assert_contains "${LAYER_NAMES[*]}" "foundation"
  assert_contains "${LAYER_NAMES[*]}" "tools"
  assert_contains "${LAYER_NAMES[*]}" "runtime"
  _pass
}

test_cache_list_shows_image_info() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  ensure_test_image
  capture_fn cmd_cache_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Image:"
  assert_contains "$TEST_OUTPUT" "isopod-test-workspace"
  _pass
}

test_cache_list_no_image() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  local containers=$(docker ps -q --filter "ancestor=$WORKSPACE_IMAGE" 2>/dev/null)
  if [[ -n "$containers" ]]; then
    docker stop $containers >/dev/null 2>&1 || true
    docker rm $containers >/dev/null 2>&1 || true
  fi
  docker rmi -f "$WORKSPACE_IMAGE" >/dev/null 2>&1 || true
  capture_fn cmd_cache_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "not built"
  _pass
}

test_cache_list_shows_fresh_after_save() {
  setup_test_env
  source_isopod_libs
  _layers_save_all
  capture_fn cmd_cache_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "fresh"
  _pass
}

test_cache_list_shows_stale() {
  setup_test_env
  source_isopod_libs
  _layers_save_all
  # Change the Dockerfile so layers become stale
  cat > "$TEST_DOCKER_DIR/workspace.Dockerfile" <<'EOF'
# layer: base
FROM ubuntu:latest
# layer: system-deps
RUN apt-get update
# layer: app
RUN mkdir -p /workspace
EOF
  _layers_init
  capture_fn cmd_cache_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "stale"
  _pass
}

test_cache_list_no_dockerfile() {
  setup_test_env
  rm -f "$TEST_DOCKER_DIR/workspace.Dockerfile"
  source_isopod_libs
  capture_fn cmd_cache_list
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "No layers found"
  _pass
}

# ── cache delete ─────────────────────────────────────────────────────────────

test_cache_delete_marks_stale() {
  setup_test_env
  source_isopod_libs
  _layers_save_all
  capture_fn cmd_cache_delete "base"
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "deleted"
  assert_file_not_exists "$TEST_DOCKER_DIR/.cache-hashes/layer.base"
  _pass
}

test_cache_delete_unknown_layer() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_cache_delete "nonexistent"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Unknown layer"
  _pass
}

test_cache_delete_no_args() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_cache_delete
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage"
  _pass
}

# ── cache rebuild ────────────────────────────────────────────────────────────

test_cache_rebuild_unknown_layer() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_cache_rebuild "nonexistent"
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Unknown layer"
  _pass
}

test_cache_rebuild_no_args() {
  setup_test_env
  source_isopod_libs
  capture_fn cmd_cache_rebuild
  assert_exit_code 1
  assert_contains "$TEST_OUTPUT" "Usage"
  _pass
}

# ── cache destroy ────────────────────────────────────────────────────────────

test_cache_destroy_removes_image() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  ensure_test_image
  capture_fn cmd_cache_destroy
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "Removing workspace image"
  assert_contains "$TEST_OUTPUT" "Cache destroyed"
  assert_image_not_exists "$WORKSPACE_IMAGE"
  _pass
}

test_cache_destroy_no_image() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  docker rmi "$WORKSPACE_IMAGE" >/dev/null 2>&1 || true
  capture_fn cmd_cache_destroy
  assert_exit_code 0
  assert_contains "$TEST_OUTPUT" "No workspace image found"
  assert_contains "$TEST_OUTPUT" "Cache destroyed"
  _pass
}

test_cache_destroy_removes_hash_dir() {
  require_docker_for_test
  setup_test_env
  source_isopod_libs
  mkdir -p "$TEST_DOCKER_DIR/.cache-hashes"
  echo "abc123:2026-03" > "$TEST_DOCKER_DIR/.cache-hashes/api.seeds"
  capture_fn cmd_cache_destroy
  assert_exit_code 0
  assert_file_not_exists "$TEST_DOCKER_DIR/.cache-hashes"
  _pass
}

# ── layer helpers ────────────────────────────────────────────────────────────

test_layer_exists_valid() {
  setup_test_env
  source_isopod_libs
  _layer_exists "base"
  assert_eq "0" "$?"
  _pass
}

test_layer_exists_invalid() {
  setup_test_env
  source_isopod_libs
  _layer_exists "nonexistent"
  assert_eq "1" "$?"
  _pass
}

test_layers_after() {
  setup_test_env
  source_isopod_libs
  local result=$(_layers_after "base")
  assert_contains "$result" "system-deps"
  assert_contains "$result" "app"
  assert_not_contains "$result" "base"
  _pass
}

test_layers_from() {
  setup_test_env
  source_isopod_libs
  local result=$(_layers_from "system-deps")
  assert_contains "$result" "system-deps"
  assert_contains "$result" "app"
  assert_not_contains "$result" "base"
  _pass
}

test_layer_save_and_detect_fresh() {
  setup_test_env
  source_isopod_libs
  _layer_save_version "base" "$(_layer_current_version base)"
  local result=$(_layer_status "base")
  assert_eq "fresh" "$result"
  _pass
}

test_layer_detect_stale() {
  setup_test_env
  source_isopod_libs
  _layer_save_version "base" "old-value"
  local result=$(_layer_status "base")
  assert_eq "stale" "$result"
  _pass
}

test_layer_detect_not_built() {
  setup_test_env
  source_isopod_libs
  local result=$(_layer_status "base")
  assert_eq "not built" "$result"
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
