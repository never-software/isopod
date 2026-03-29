#!/bin/zsh
# commands/nuke.sh — Remove all containers, volumes, and cache while keeping pod directories

cmd_nuke() {
  require_docker

  header "Nuking all Docker resources (pod directories will be kept)"

  # ── Stop and remove all pod containers ──────────────────────────────────────
  local containers_removed=0
  if [[ -d "$PODS_DIR" ]]; then
    for dir in "$PODS_DIR"/*/; do
      [[ -d "$dir" ]] || continue
      local name=$(basename "$dir")
      local compose_file=$(compose_file_for "$name")
      local project=$(compose_project "$name")

      if [[ -f "$compose_file" ]]; then
        # Try the standard isopod project name first, then check if the
        # container was created under a different project name
        local actual_project="$project"
        local container=$(workspace_container "$name")
        local label_project=$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null)
        [[ -n "$label_project" ]] && actual_project="$label_project"

        info "Stopping container: $name"
        docker compose -p "$actual_project" -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || \
          docker rm -f "$container" >/dev/null 2>&1 || true
        containers_removed=$((containers_removed + 1))
      fi
    done
  fi

  if [[ $containers_removed -gt 0 ]]; then
    success "$containers_removed container(s) removed"
  else
    info "No pod containers to remove"
  fi

  # ── Remove all isopod volumes ───────────────────────────────────────────────
  local volumes_removed=0

  # pod data volumes
  local data_vols=($(docker volume ls --format '{{.Name}}' --filter "name=isopod-" 2>/dev/null | grep "_data$"))
  for vol in "${data_vols[@]}"; do
    [[ -n "$vol" ]] || continue
    info "Removing volume: $vol"
    docker volume rm "$vol" >/dev/null 2>&1 || warn "Could not remove $vol (may be in use)"
    volumes_removed=$((volumes_removed + 1))
  done

  # snapshot volumes
  local snap_vols=($(docker volume ls --format '{{.Name}}' --filter "name=isopod-snap-" 2>/dev/null))
  for vol in "${snap_vols[@]}"; do
    [[ -n "$vol" ]] || continue
    info "Removing volume: $vol"
    docker volume rm "$vol" >/dev/null 2>&1 || warn "Could not remove $vol (may be in use)"
    volumes_removed=$((volumes_removed + 1))
  done

  if [[ $volumes_removed -gt 0 ]]; then
    success "$volumes_removed volume(s) removed"
  else
    info "No isopod volumes to remove"
  fi

  # ── Destroy cache ───────────────────────────────────────────────────────────
  if docker image inspect "$WORKSPACE_IMAGE" &>/dev/null 2>&1; then
    info "Removing workspace image: $WORKSPACE_IMAGE"
    docker rmi "$WORKSPACE_IMAGE" 2>/dev/null || warn "Could not remove image (may be in use by running containers)"
  else
    info "No workspace image to remove"
  fi

  local cache_hash_dir="$DOCKER_DIR/.cache-hashes"
  if [[ -d "$cache_hash_dir" ]]; then
    info "Removing cached hashes"
    rm -rf "$cache_hash_dir"
  fi

  docker image prune -f 2>/dev/null | grep -v "Total reclaimed space: 0B" || true

  # ── Summary ─────────────────────────────────────────────────────────────────
  echo ""
  success "Nuke complete. Pod directories preserved in $PODS_DIR"
  info "Run 'isopod build' to rebuild the workspace image"
  info "Run 'isopod up <name>' to restart a pod"
}
