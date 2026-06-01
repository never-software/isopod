#!/bin/zsh
# tests/test_sharing.sh — Per-entry workspace sharing resolver & mount generation

source "$(dirname "$0")/test_helper.sh"

# Build a fixture: a temp PROJECT_ROOT with an empty pod_workspace_template/.
# Sets the global TEMPLATE to the template dir for convenience.
_setup_sharing_fixture() {
  setup_test_env
  source_isopod_libs
  export PROJECT_ROOT="$TEST_TMPDIR"
  TEMPLATE="$TEST_TMPDIR/pod_workspace_template"
  mkdir -p "$TEMPLATE"
}

# ── Default behavior (back-compat) ────────────────────────────────────────────

test_sharing_default_shared_dir_mount() {
  _setup_sharing_fixture
  mkdir -p "$TEMPLATE/.agent-config"

  capture workspace_template_volumes "$TEST_PODS_DIR/feat"
  assert_exit_code 0
  # No manifest ⇒ default shared ⇒ a single live template dir mount (today's behavior).
  assert_contains "$TEST_STDOUT" "$TEMPLATE/.agent-config:/workspace/.agent-config:delegated"
  _pass
}

# ── Resolution (most-specific wins) ───────────────────────────────────────────

test_sharing_longest_prefix_wins() {
  _setup_sharing_fixture
  cat > "$TEST_TMPDIR/.workspace-sharing" <<'EOF'
default shared
local .claude
shared .claude/CLAUDE.md
EOF
  assert_eq "local"  "$(sharing_effective_mode .claude/settings.json)"
  assert_eq "shared" "$(sharing_effective_mode .claude/CLAUDE.md)"
  assert_eq "shared" "$(sharing_effective_mode prod-backup)"
  _pass
}

# ── Collapse rule: fully-shared folder → one dir mount ────────────────────────

test_sharing_shared_folder_collapses() {
  _setup_sharing_fixture
  mkdir -p "$TEMPLATE/.claude/skills"
  echo x > "$TEMPLATE/.claude/CLAUDE.md"
  echo y > "$TEMPLATE/.claude/skills/a.md"

  capture workspace_template_volumes "$TEST_PODS_DIR/feat"
  assert_contains "$TEST_STDOUT" "$TEMPLATE/.claude:/workspace/.claude:delegated"
  # Collapsed: no per-file mounts emitted for descendants.
  assert_not_contains "$TEST_STDOUT" "/workspace/.claude/CLAUDE.md"
  _pass
}

# ── Collapse rule: mixed folder → per-leaf mounts + local from pod copy ────────

test_sharing_mixed_folder() {
  _setup_sharing_fixture
  mkdir -p "$TEMPLATE/.claude/skills"
  echo x > "$TEMPLATE/.claude/CLAUDE.md"
  echo y > "$TEMPLATE/.claude/settings.local.json"
  echo z > "$TEMPLATE/.claude/skills/a.md"
  cat > "$TEST_TMPDIR/.workspace-sharing" <<'EOF'
default shared
local .claude/settings.local.json
EOF

  capture workspace_template_volumes "$TEST_PODS_DIR/feat"
  # skills/ is fully shared inside the mixed parent → collapses to a dir mount.
  assert_contains "$TEST_STDOUT" "$TEMPLATE/.claude/skills:/workspace/.claude/skills:delegated"
  # A shared file directly in the mixed folder → per-file mount.
  assert_contains "$TEST_STDOUT" "$TEMPLATE/.claude/CLAUDE.md:/workspace/.claude/CLAUDE.md:delegated"
  # The local exception → mounted from the per-pod copy, NOT the template.
  assert_contains "$TEST_STDOUT" "./.isopod-local/.claude/settings.local.json:/workspace/.claude/settings.local.json:delegated"
  assert_not_contains "$TEST_STDOUT" "$TEMPLATE/.claude/settings.local.json:"
  _pass
}

# ── Materialization: seed copy-missing for local entries ──────────────────────

test_sharing_sync_seeds_local_copy() {
  _setup_sharing_fixture
  mkdir -p "$TEMPLATE/.claude"
  echo y > "$TEMPLATE/.claude/settings.local.json"
  mkdir -p "$TEST_PODS_DIR/feat"
  cat > "$TEST_TMPDIR/.workspace-sharing" <<'EOF'
default shared
local .claude/settings.local.json
EOF

  capture_fn sync_local_workspace_entries feat
  assert_exit_code 0
  assert_file_exists "$TEST_PODS_DIR/feat/.isopod-local/.claude/settings.local.json"
  _pass
}

# ── Migration: local→shared flip removes stale copy; guards protect pod dirs ──

test_sharing_flip_cleans_stale_copy() {
  _setup_sharing_fixture
  mkdir -p "$TEMPLATE/.claude"
  echo y > "$TEMPLATE/.claude/settings.local.json"
  mkdir -p "$TEST_PODS_DIR/feat/api/.git"            # a repo dir (has .git)
  echo "compose" > "$TEST_PODS_DIR/feat/docker-compose.yml"

  cat > "$TEST_TMPDIR/.workspace-sharing" <<'EOF'
default shared
local .claude/settings.local.json
EOF
  sync_local_workspace_entries feat
  assert_file_exists "$TEST_PODS_DIR/feat/.isopod-local/.claude/settings.local.json"

  # Flip back to shared (no manifest ⇒ default shared) and re-sync.
  rm -f "$TEST_TMPDIR/.workspace-sharing"
  capture_fn sync_local_workspace_entries feat
  assert_exit_code 0
  assert_file_not_exists "$TEST_PODS_DIR/feat/.isopod-local/.claude/settings.local.json"
  # Safety guards: deletion is confined to .isopod-local.
  assert_dir_exists "$TEST_PODS_DIR/feat/api/.git"
  assert_file_exists "$TEST_PODS_DIR/feat/docker-compose.yml"
  _pass
}

# ── Run ───────────────────────────────────────────────────────────────────────
run_test_file
print_summary
