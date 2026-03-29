#!/bin/zsh
# lib/git.sh — Repo copy and branch creation helper
#
# Copies repos from repos/ into pods using rsync, then creates a feature branch.
# We use plain copies instead of git worktrees because worktrees won't let you
# check out a branch that's already checked out elsewhere — which makes them
# useless for parallel pods that may share a starting branch.

# Detect the default branch for a repo (e.g. "main" or "master").
# Returns the bare branch name, not the remote ref.
# Usage: default_branch_for <repo_path>
default_branch_for() {
  local repo_dir="$1"
  local branch
  branch=$(cd "$repo_dir" && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||') || true
  if [[ -z "$branch" ]]; then
    if (cd "$repo_dir" && git rev-parse --verify origin/main &>/dev/null 2>&1); then
      branch="main"
    elif (cd "$repo_dir" && git rev-parse --verify origin/master &>/dev/null 2>&1); then
      branch="master"
    fi
  fi
  echo "$branch"
}

# Create a local clone of a repo for a workspace, optionally branching from a base.
# Usage: create_repo_clone <repo_root> <clone_path> <branch_name> [start_point]
create_repo_clone() {
  local repo_root="$1"
  local clone_path="$2"
  local branch_name="$3"
  local start_point="${4:-}"
  local repo_name=$(basename "$repo_root")

  # Copy the repo (fast, preserves gitignored files like .env)
  # Uses rsync instead of cp -r because node_modules may contain symlinks
  # that cp can't resolve, causing fatal errors. rsync handles them gracefully.
  info "Copying $repo_name..."
  rsync -a --exclude='node_modules' "$repo_root/" "$clone_path/" || error "Failed to copy $repo_name"

  # Fetch the latest from origin
  info "Fetching latest from origin for $repo_name..."
  (cd "$clone_path" && git fetch origin 2>&1) || warn "Failed to fetch origin for $repo_name"

  # Determine start point if not specified (only if repo has remote refs)
  if [[ -z "$start_point" ]]; then
    local has_remote=false
    (cd "$clone_path" && git remote get-url origin &>/dev/null 2>&1) && has_remote=true

    if [[ "$has_remote" == "true" ]]; then
      local default_branch
      default_branch=$(default_branch_for "$clone_path")
      if [[ -n "$default_branch" ]]; then
        start_point="origin/$default_branch"
      fi
    fi
  fi

  # Create and checkout the feature branch
  if [[ -n "$start_point" ]]; then
    (cd "$clone_path" && git checkout -b "$branch_name" "$start_point" 2>&1) || {
      # Branch might already exist — just check it out
      (cd "$clone_path" && git checkout "$branch_name" 2>&1) || error "Failed to checkout $branch_name in $repo_name"
    }
  else
    (cd "$clone_path" && git checkout -b "$branch_name" 2>&1) || {
      (cd "$clone_path" && git checkout "$branch_name" 2>&1) || error "Failed to checkout $branch_name in $repo_name"
    }
  fi

  success "$repo_name workspace created"
}
