#!/bin/zsh
# lib/helpers/sharing.sh — Per-entry workspace sharing resolver
#
# Each top-level entry of pod_workspace_template/ is mounted into a pod's
# /workspace. By default every entry is "shared" — a live bind mount of the
# canonical template, so edits flow back and across pods (today's behavior).
# A sparse manifest ($PROJECT_ROOT/.workspace-sharing) lets the user mark
# individual files/folders "local" instead — a per-pod copy whose edits never
# flow back. Resolution is most-specific (longest path-prefix) wins.
#
# This file is the SOURCE OF TRUTH for which mounts a pod actually gets. The
# dashboard server re-implements only the longest-prefix lookup for display.
#
# Manifest format (line-based, so no jq dependency in the engine hot path):
#   # comment
#   default shared              # default mode (absent => shared)
#   local  .claude/settings.local.json
#   shared .claude/CLAUDE.md    # override back to shared inside a local folder
#
# Public functions:
#   sharing_manifest_path                 → path to the manifest file
#   sharing_effective_mode <relpath>      → "shared" | "local" for a path
#   workspace_template_volumes <pod_dir>  → compose volume lines (one per line)
#   sync_local_workspace_entries <feat>   → seed/clean pods/<feat>/.isopod-local/

# Path to the per-project sharing manifest. Lives at the repo root (outside
# pod_workspace_template/ so it is never itself a pod artifact).
sharing_manifest_path() {
  echo "$PROJECT_ROOT/.workspace-sharing"
}

# Parse the manifest into SHARING_DEFAULT (string) and SHARING_OVERRIDES (assoc).
_sharing_load_manifest() {
  typeset -gA SHARING_OVERRIDES
  SHARING_OVERRIDES=()
  typeset -g SHARING_DEFAULT="shared"

  local mf
  mf="$(sharing_manifest_path)"
  [[ -f "$mf" ]] || return 0

  local line
  while IFS= read -r line; do
    line="${line%%#*}"          # strip trailing comments
    local toks=(${=line})        # whitespace-split, drops empty fields
    (( ${#toks} == 0 )) && continue
    if [[ "${toks[1]}" == "default" ]]; then
      [[ -n "${toks[2]:-}" ]] && SHARING_DEFAULT="${toks[2]}"
    elif [[ "${toks[1]}" == "shared" || "${toks[1]}" == "local" ]]; then
      [[ -n "${toks[2]:-}" ]] && SHARING_OVERRIDES[${toks[2]}]="${toks[1]}"
    fi
  done < "$mf"
}

# Serialize the in-memory SHARING_DEFAULT/SHARING_OVERRIDES back to the manifest
# (canonical form: header, default, then overrides sorted by path).
_sharing_write_manifest() {
  local mf k
  mf="$(sharing_manifest_path)"
  {
    echo "# .workspace-sharing — per-entry workspace sharing manifest"
    echo "# Managed by 'isopod sharing' and the dashboard. mode: shared | local"
    echo "default ${SHARING_DEFAULT:-shared}"
    for k in ${(ok)SHARING_OVERRIDES}; do
      echo "${SHARING_OVERRIDES[$k]} $k"
    done
  } > "$mf"
}

# Effective mode for a path = the override whose key is the longest prefix of
# (or equal to) it, else the default. Assumes SHARING_* already loaded.
_sharing_mode() {
  local rel="$1"
  local best_len=-1 best_mode="$SHARING_DEFAULT" k
  for k in ${(k)SHARING_OVERRIDES}; do
    if [[ "$rel" == "$k" || "$rel" == "$k/"* ]]; then
      if (( ${#k} > best_len )); then
        best_len=${#k}
        best_mode="${SHARING_OVERRIDES[$k]}"
      fi
    fi
  done
  echo "$best_mode"
}

# True if any override strictly under <rel> has the given mode (=> mixed dir).
_sharing_has_under() {
  local rel="$1" target="$2" k
  for k in ${(k)SHARING_OVERRIDES}; do
    [[ "$k" == "$rel/"* && "${SHARING_OVERRIDES[$k]}" == "$target" ]] && return 0
  done
  return 1
}

# Recursively walk the template, applying the collapse rule, appending to
# SHARING_MOUNTS (compose lines) and SHARING_LOCAL (rel paths needing a copy).
_sharing_walk() {
  local rel="$1" abs="$2"

  if [[ -n "$rel" && -d "$abs" ]]; then
    local mode
    mode="$(_sharing_mode "$rel")"
    # Fully-shared directory → one live template dir mount; stop descending.
    if [[ "$mode" == "shared" ]] && ! _sharing_has_under "$rel" "local"; then
      SHARING_MOUNTS+=("      - ${abs}:/workspace/${rel}:delegated")
      return
    fi
    # Fully-local directory → one per-pod copy dir mount; stop descending.
    if [[ "$mode" == "local" ]] && ! _sharing_has_under "$rel" "shared"; then
      SHARING_MOUNTS+=("      - ./.isopod-local/${rel}:/workspace/${rel}:delegated")
      SHARING_LOCAL+=("$rel")
      return
    fi
  elif [[ -n "$rel" ]]; then
    # A plain file entry at this rel.
    local fmode
    fmode="$(_sharing_mode "$rel")"
    if [[ "$fmode" == "local" ]]; then
      SHARING_MOUNTS+=("      - ./.isopod-local/${rel}:/workspace/${rel}:delegated")
      SHARING_LOCAL+=("$rel")
    else
      SHARING_MOUNTS+=("      - ${abs}:/workspace/${rel}:delegated")
    fi
    return
  fi

  # Mixed directory (or the template root) → descend.
  local item name crel
  for item in "$abs"/*(DN); do
    name="$(basename "$item")"
    case "$name" in
      .gitkeep|.DS_Store|.git|node_modules) continue ;;
    esac
    if [[ -n "$rel" ]]; then crel="$rel/$name"; else crel="$name"; fi
    _sharing_walk "$crel" "$item"
  done
}

# Resolve all mounts + local-copy paths for a pod into SHARING_MOUNTS/SHARING_LOCAL.
_sharing_collect() {
  typeset -ga SHARING_MOUNTS SHARING_LOCAL
  SHARING_MOUNTS=()
  SHARING_LOCAL=()
  _sharing_load_manifest

  local template_dir="$PROJECT_ROOT/pod_workspace_template"
  [[ -d "$template_dir" ]] || return 0
  _sharing_walk "" "$template_dir"
}

# Public: effective mode for a single path (used by the CLI and tests).
sharing_effective_mode() {
  _sharing_load_manifest
  _sharing_mode "$1"
}

# Public: emit the compose volume lines for a pod's workspace template entries.
workspace_template_volumes() {
  _sharing_collect "$1"
  local line
  for line in "${SHARING_MOUNTS[@]}"; do
    print -r -- "$line"
  done
}

# ── Local-copy materialization (called from `up`, before compose generation) ──

# Classify a path found under .isopod-local relative to the resolved local set:
#   under    — at or below a local entry  (keep the whole subtree)
#   ancestor — a parent dir of a local entry (descend; parts may be stale)
#   stale    — neither (the entry flipped to shared) → safe to delete
_sharing_local_status() {
  local rel="$1" e
  for e in "${SHARING_LOCAL[@]}"; do
    [[ "$rel" == "$e" || "$rel" == "$e/"* ]] && { echo under; return; }
  done
  for e in "${SHARING_LOCAL[@]}"; do
    [[ "$e" == "$rel/"* ]] && { echo ancestor; return; }
  done
  echo stale
}

_sharing_clean_walk() {
  local abs="$1" rel="$2" item name crel
  for item in "$abs"/*(DN); do
    name="$(basename "$item")"
    if [[ -n "$rel" ]]; then crel="$rel/$name"; else crel="$name"; fi
    case "$(_sharing_local_status "$crel")" in
      under) ;;                                    # keep entire subtree
      ancestor) [[ -d "$item" ]] && _sharing_clean_walk "$item" "$crel" ;;
      stale) rm -rf "$item" ;;                     # only ever inside .isopod-local
    esac
  done
}

# Seed (copy-missing) local entries into pods/<feat>/.isopod-local/ and remove
# stale copies for entries that have flipped back to shared. Destructive work is
# confined to the .isopod-local sandbox — it never touches repo dirs, the
# generated docker-compose.yml, or anything outside that directory.
sync_local_workspace_entries() {
  local feature_name="$1"
  local pod_dir="$PODS_DIR/$feature_name"
  local template_dir="$PROJECT_ROOT/pod_workspace_template"
  [[ -d "$template_dir" ]] || return 0

  _sharing_collect "$pod_dir"
  local local_root="$pod_dir/.isopod-local"

  local rel src dst
  for rel in "${SHARING_LOCAL[@]}"; do
    src="$template_dir/$rel"
    dst="$local_root/$rel"
    [[ -e "$src" ]] || continue
    if [[ ! -e "$dst" ]]; then
      mkdir -p "$(dirname "$dst")"
      cp -a "$src" "$dst"
    fi
  done

  if [[ -d "$local_root" ]]; then
    _sharing_clean_walk "$local_root" ""
    find "$local_root" -type d -empty -delete 2>/dev/null || true
  fi
}
