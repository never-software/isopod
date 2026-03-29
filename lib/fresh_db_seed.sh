#!/bin/zsh
# commands/fresh_db_seed.sh — Build image and seed the base database

cmd_fresh_db_seed() {
  header "Fresh DB Seed"

  require_docker

  # Build the base image
  build_all

  # Delegate to project-specific seed hook
  local seed_hook="$DOCKER_DIR/hooks/fresh-db-seed"
  if [[ -x "$seed_hook" ]]; then
    info "Running fresh-db-seed hook..."
    DOCKER_DIR="$DOCKER_DIR" \
    PROJECT_ROOT="$PROJECT_ROOT" \
    REPOS_DIR="$REPOS_DIR" \
    WORKSPACE_IMAGE="$WORKSPACE_IMAGE" \
    PROJECT_NAME="$PROJECT_NAME" \
      "$seed_hook"
  else
    success "Image rebuilt. No fresh-db-seed hook found — skipping seed step."
  fi

  # Delegate seed hash update to project-specific hook
  local hash_hook="$DOCKER_DIR/hooks/update-seed-hashes"
  if [[ -x "$hash_hook" ]]; then
    DOCKER_DIR="$DOCKER_DIR" \
    REPOS_DIR="$REPOS_DIR" \
      "$hash_hook"
  fi
}
