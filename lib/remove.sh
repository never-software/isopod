#!/bin/zsh
# commands/remove.sh — Remove a workspace and its container

cmd_remove() {
  local feature_name="${1:-}"
  local force=false

  # Parse --force flag
  for arg in "$@"; do
    [[ "$arg" == "--force" ]] && force=true
  done

  [[ -z "$feature_name" ]] && error "Usage: isopod remove <feature-name> [--force]"

  local pod_dir="$PODS_DIR/$feature_name"
  [[ ! -d "$pod_dir" ]] && error "Pod '$feature_name' not found at $pod_dir"

  # ── Safety check: warn about uncommitted changes and unpushed commits ──
  if [[ "$force" != "true" ]]; then
    local warnings=()

    for repo_name in "${ALL_REPO_DIRS[@]}"; do
      local repo_path="$pod_dir/$repo_name"
      [[ ! -d "$repo_path/.git" ]] && continue

      # Check for uncommitted changes (modified, staged, or untracked)
      local dirty
      dirty=$(cd "$repo_path" && git status --porcelain 2>/dev/null) || true
      if [[ -n "$dirty" ]]; then
        local changed=$(echo "$dirty" | wc -l | tr -d ' ')
        warnings+=("  ${YELLOW}⚠${NC}  $repo_name has ${BOLD}$changed uncommitted change(s)${NC}")
      fi

      # Check ALL local branches for unpushed commits
      local branches
      branches=$(cd "$repo_path" && git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null) || true
      [[ -z "$branches" ]] && continue
      while IFS= read -r branch; do
        [[ -z "$branch" ]] && continue
        local upstream
        upstream=$(cd "$repo_path" && git rev-parse --verify "origin/$branch" 2>/dev/null) || true
        if [[ -n "$upstream" ]]; then
          local unpushed
          unpushed=$(cd "$repo_path" && git log --oneline "origin/$branch..$branch" 2>/dev/null | wc -l | tr -d ' ') || true
          if [[ -n "$unpushed" ]] && [[ "$unpushed" -gt 0 ]]; then
            warnings+=("  ${YELLOW}⚠${NC}  $repo_name has ${BOLD}$unpushed unpushed commit(s)${NC} on $branch")
          fi
        else
          # No remote tracking — entire branch is local-only
          warnings+=("  ${YELLOW}⚠${NC}  $repo_name has ${BOLD}local-only branch${NC} '$branch' (no remote)")
        fi
      done <<< "$branches"
    done

    if [[ ${#warnings[@]} -gt 0 ]]; then
      echo ""
      warn "The following repos have unsaved work that will be ${RED}permanently lost${NC}:"
      echo ""
      for w in "${warnings[@]}"; do
        echo "$w"
      done
      echo ""
      echo -n "${BOLD}Are you sure you want to remove '$feature_name'?${NC} [y/N] "
      read -r confirm
      if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
        info "Aborted."
        return 0
      fi
    fi
  fi

  header "Removing pod: $feature_name"

  local compose_file=$(compose_file_for "$feature_name")
  local project=$(compose_project "$feature_name")

  # Tear down workspace resources (hooks) — ISOPOD_REMOVING tells hooks to close windows
  export ISOPOD_REMOVING=true
  teardown_workspace "$feature_name"

  info "Stopping and removing container..."
  docker compose -p "$project" -f "$compose_file" down -v 2>&1 && \
    success "Container and volumes removed" || \
    warn "Failed to remove container — it may not have been running"

  # ── Remove workspace clones ──
  info "Removing workspace directory..."
  rm -rf "$pod_dir"
  success "Directory cleaned up"

  docker_cleanup
  success "Done! Pod '$feature_name' fully removed."
}
