#!/bin/zsh
# commands/sharing.sh — Inspect and edit the workspace sharing manifest
#
# The manifest controls whether each pod_workspace_template/ entry is "shared"
# (a live bind mount of the canonical template — the default) or "local" (a
# per-pod copy whose edits never flow back). See lib/helpers/sharing.sh.

_sharing_cli_list() {
  echo "${BOLD}Workspace sharing${NC}  ${DIM}($(sharing_manifest_path))${NC}"
  echo "  default: ${SHARING_DEFAULT}"
  local k
  if (( ${#SHARING_OVERRIDES} == 0 )); then
    echo "  ${DIM}(no overrides — every entry is '${SHARING_DEFAULT}')${NC}"
    return
  fi
  echo "  overrides:"
  for k in ${(ok)SHARING_OVERRIDES}; do
    printf "    %-7s %s\n" "${SHARING_OVERRIDES[$k]}" "$k"
  done
}

cmd_sharing() {
  local sub="${1:-list}"
  shift 2>/dev/null || true

  case "$sub" in
    list|ls)
      _sharing_load_manifest
      _sharing_cli_list
      ;;
    set)
      local path="${1:-}" mode="${2:-}"
      [[ -z "$path" || -z "$mode" ]] && error "Usage: isopod sharing set <path> <shared|local>"
      [[ "$mode" == "shared" || "$mode" == "local" ]] || error "Mode must be 'shared' or 'local'"
      _sharing_load_manifest
      SHARING_OVERRIDES[$path]="$mode"
      _sharing_write_manifest
      success "Set $path → $mode"
      ;;
    unset|rm)
      local path="${1:-}"
      [[ -z "$path" ]] && error "Usage: isopod sharing unset <path>"
      _sharing_load_manifest
      unset "SHARING_OVERRIDES[$path]"
      _sharing_write_manifest
      success "Removed override for $path"
      ;;
    default)
      local mode="${1:-}"
      [[ "$mode" == "shared" || "$mode" == "local" ]] || error "Usage: isopod sharing default <shared|local>"
      _sharing_load_manifest
      SHARING_DEFAULT="$mode"
      _sharing_write_manifest
      success "Default → $mode"
      ;;
    *)
      error "Usage: isopod sharing [list|set <path> <shared|local>|unset <path>|default <shared|local>]"
      ;;
  esac
}
