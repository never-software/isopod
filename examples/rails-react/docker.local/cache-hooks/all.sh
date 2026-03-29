#!/bin/bash
# cache-hooks/all.sh — Generate Dockerfile dependency instructions
#
# Iterates over each repo in REPOS_DIR. For each repo, runs every sibling
# hook. Each hook checks if it's relevant (e.g., gems.sh skips repos
# without a Gemfile) and outputs Dockerfile instructions if so.
#
# Environment variables (set by isopod):
#   REPOS_DIR        — Path to the repos/ directory
#   DOCKER_DIR       — Path to the active docker config directory
#   PROJECT_ROOT     — Path to the project root
#   HOOK_FILTER      — (optional) Only run this hook (e.g., "gems")
#   REPO_FILTER      — (optional) Only run against this repo (e.g., "example-api")

set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
HOOKS_DIR="$(dirname "$SELF")"

for repo_dir in "$REPOS_DIR"/*/; do
  [[ -d "$repo_dir" ]] || continue
  repo_name=$(basename "$repo_dir")

  if [[ -n "${REPO_FILTER:-}" ]] && [[ "$repo_name" != "$REPO_FILTER" ]]; then
    continue
  fi

  for hook in "$HOOKS_DIR"/*; do
    [[ -f "$hook" ]] || continue
    [[ -x "$hook" ]] || continue
    [[ "$hook" = "$SELF" ]] && continue

    hook_name=$(basename "$hook" .sh)

    if [[ -n "${HOOK_FILTER:-}" ]] && [[ "$hook_name" != "$HOOK_FILTER" ]]; then
      continue
    fi

    REPO_DIR="$repo_dir" \
    REPO_NAME="$repo_name" \
    DOCKER_DIR="$DOCKER_DIR" \
    WORKSPACE_IMAGE="${WORKSPACE_IMAGE:-}" \
      "$hook"
  done
done
