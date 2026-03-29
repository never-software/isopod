#!/bin/zsh
# lib/db.sh — Database snapshot management (save/restore/list/delete)
#
# Database-agnostic: delegates stop/start to hooks in docker.local/hooks/.
# The core mechanism copies Docker volumes, which works for any database.

SNAP_PREFIX="isopod-snap"

# ── Helpers ──────────────────────────────────────────────────────────────────

# Get the data volume name for a pod
_data_volume() {
  echo "isopod-${1}_data"
}

# Get the snapshot volume name
_snap_volume() {
  echo "${SNAP_PREFIX}-${1}"
}

# Stop the database inside a running container via hook
_db_stop() {
  local container="$1"
  local hook="$DOCKER_DIR/hooks/db-stop"
  if [[ -x "$hook" ]]; then
    CONTAINER="$container" "$hook"
  else
    warn "No db-stop hook found — skipping database stop (snapshot may be inconsistent)"
  fi
}

# Start the database inside a running container via hook
_db_start() {
  local container="$1"
  local hook="$DOCKER_DIR/hooks/db-start"
  if [[ -x "$hook" ]]; then
    CONTAINER="$container" "$hook"
  else
    warn "No db-start hook found — skipping database start"
  fi
}

# Copy one Docker volume to another using a lightweight alpine container
_copy_volume() {
  local src="$1" dst="$2"
  docker run --rm \
    -v "${src}:/from:ro" \
    -v "${dst}:/to" \
    alpine sh -c "rm -rf /to/* /to/..?* /to/.[!.]* 2>/dev/null; cp -a /from/. /to/" 2>&1
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_db_save() {
  local feature_name="${1:-}"
  local snap_name="${2:-}"
  [[ -z "$feature_name" || -z "$snap_name" ]] && error "Usage: isopod db save <feature-name> <snapshot-name>"

  local pod_dir="$PODS_DIR/$feature_name"
  [[ ! -d "$pod_dir" ]] && error "Pod '$feature_name' not found"

  require_docker

  local container=$(workspace_container "$feature_name")
  docker inspect "$container" &>/dev/null 2>&1 || error "Container '$container' is not running. Start it with: isopod up $feature_name"

  local data_vol=$(_data_volume "$feature_name")
  local snap_vol=$(_snap_volume "$snap_name")

  # Check if snapshot already exists
  if docker volume inspect "$snap_vol" &>/dev/null 2>&1; then
    warn "Snapshot '$snap_name' already exists — overwriting"
    docker volume rm "$snap_vol" &>/dev/null 2>&1 || true
  fi

  header "Saving database snapshot: $snap_name"

  info "Stopping database..."
  _db_stop "$container"

  info "Creating snapshot volume..."
  docker volume create "$snap_vol" &>/dev/null

  info "Copying data → $snap_name..."
  _copy_volume "$data_vol" "$snap_vol"

  info "Starting database..."
  _db_start "$container"

  success "Snapshot '$snap_name' saved from '$feature_name'"
}

cmd_db_restore() {
  local feature_name="${1:-}"
  local snap_name="${2:-}"
  [[ -z "$feature_name" || -z "$snap_name" ]] && error "Usage: isopod db restore <feature-name> <snapshot-name>"

  local pod_dir="$PODS_DIR/$feature_name"
  [[ ! -d "$pod_dir" ]] && error "Pod '$feature_name' not found"

  require_docker

  local container=$(workspace_container "$feature_name")
  docker inspect "$container" &>/dev/null 2>&1 || error "Container '$container' is not running. Start it with: isopod up $feature_name"

  local data_vol=$(_data_volume "$feature_name")
  local snap_vol=$(_snap_volume "$snap_name")

  # Check snapshot exists
  docker volume inspect "$snap_vol" &>/dev/null 2>&1 || error "Snapshot '$snap_name' not found. Run 'isopod db list' to see available snapshots."

  header "Restoring database snapshot: $snap_name → $feature_name"

  info "Stopping database..."
  _db_stop "$container"

  info "Restoring snapshot..."
  _copy_volume "$snap_vol" "$data_vol"

  info "Starting database..."
  _db_start "$container"

  success "Snapshot '$snap_name' restored to '$feature_name'"
}

cmd_db_list() {
  require_docker

  local volumes=($(docker volume ls --format '{{.Name}}' --filter "name=${SNAP_PREFIX}-" 2>/dev/null))

  if [[ ${#volumes[@]} -eq 0 ]]; then
    echo ""
    echo "  No snapshots found."
    echo "  Create one with: isopod db save <feature-name> <snapshot-name>"
    echo ""
    return
  fi

  header "Database snapshots"

  printf "  ${BOLD}%-30s  %-20s${NC}\n" "NAME" "CREATED"
  for vol in "${volumes[@]}"; do
    local snap_name="${vol#${SNAP_PREFIX}-}"
    local created=$(docker volume inspect --format '{{.CreatedAt}}' "$vol" 2>/dev/null | cut -d'T' -f1)
    printf "  %-30s  %-20s\n" "$snap_name" "$created"
  done
  echo ""
}

cmd_db_delete() {
  local snap_name="${1:-}"
  [[ -z "$snap_name" ]] && error "Usage: isopod db delete <snapshot-name>"

  require_docker

  local snap_vol=$(_snap_volume "$snap_name")

  docker volume inspect "$snap_vol" &>/dev/null 2>&1 || error "Snapshot '$snap_name' not found"

  docker volume rm "$snap_vol" &>/dev/null 2>&1
  success "Snapshot '$snap_name' deleted"
}

# ── Router ───────────────────────────────────────────────────────────────────

cmd_db() {
  local subcmd="${1:-help}"
  shift 2>/dev/null || true

  case "$subcmd" in
    save)    cmd_db_save "$@" ;;
    restore) cmd_db_restore "$@" ;;
    list|ls) cmd_db_list ;;
    delete|rm) cmd_db_delete "$@" ;;
    help|--help|-h)
      echo ""
      echo "${BOLD}isopod db${NC} — Database snapshot management"
      echo ""
      echo "${BOLD}Subcommands:${NC}"
      echo "  ${BOLD}save${NC}      <feature> <name>    Save current DB state as a named snapshot"
      echo "  ${BOLD}restore${NC}   <feature> <name>    Restore a snapshot to a pod"
      echo "  ${BOLD}list${NC}                          List all snapshots"
      echo "  ${BOLD}delete${NC}    <name>              Delete a snapshot"
      echo ""
      ;;
    *) error "Unknown db subcommand: $subcmd. Run 'isopod db help' for usage." ;;
  esac
}
