#!/bin/zsh
# commands/cache.sh — List, rebuild, and destroy cache layers

cmd_cache_list() {
  header "Cache layers"

  if [[ ${#LAYER_NAMES[@]} -eq 0 ]]; then
    echo "  ${DIM}No layers found (no workspace.Dockerfile or no # layer: markers)${NC}"
    echo ""
    return
  fi

  printf "  ${BOLD}%-4s %-16s %-14s %s${NC}\n" "#" "LAYER" "VERSION" "STATUS"

  local idx=1
  for layer in "${LAYER_NAMES[@]}"; do
    local version=$(_layer_current_version "$layer")
    local layer_st=$(_layer_status "$layer")

    local color="$GREEN"
    local display_status="$layer_st"
    if [[ "$layer_st" == "stale" ]]; then
      local stored=$(_layer_stored_version "$layer")
      color="$YELLOW"
      display_status="stale (was $stored)"
    elif [[ "$layer_st" == "not built" ]]; then
      color="$DIM"
    fi

    printf "  %-4s %-16s %-14s %b\n" "$idx" "$layer" "$version" "${color}${display_status}${NC}"
    idx=$((idx + 1))
  done

  echo ""

  # Image info
  if docker image inspect "$WORKSPACE_IMAGE" &>/dev/null 2>&1; then
    local image_size=$(docker image inspect "$WORKSPACE_IMAGE" --format '{{.Size}}' 2>/dev/null)
    local image_created=$(docker image inspect "$WORKSPACE_IMAGE" --format '{{.Created}}' 2>/dev/null | cut -d'T' -f1)
    local image_size_mb=$((image_size / 1024 / 1024))
    echo "  ${BOLD}Image:${NC} $WORKSPACE_IMAGE (${image_size_mb}MB, built $image_created)"
  else
    echo "  ${BOLD}Image:${NC} not built"
  fi
  echo ""
}

cmd_cache_rebuild() {
  local layer="${1:-}"
  [[ -z "$layer" ]] && error "Usage: isopod cache rebuild <layer-name>"

  _layer_exists "$layer" || error "Unknown layer: $layer. Run 'isopod cache list' to see available layers."

  require_docker

  # Show cascade warning
  local cascade=($(_layers_after "$layer"))
  if [[ ${#cascade[@]} -gt 0 ]] && [[ -n "${cascade[1]}" ]]; then
    warn "Rebuilding '$layer' will also rebuild: ${cascade[*]}"
  fi

  # Invalidate stored hashes from this layer onwards
  local affected=($(_layers_from "$layer"))
  for l in "${affected[@]}"; do
    _layer_delete_version "$l"
  done

  info "Rebuilding workspace image from '$layer'..."
  build_all
  success "Rebuild complete. Run 'isopod up <name>' to apply to running pods."
}

cmd_cache_delete() {
  local layer="${1:-}"
  [[ -z "$layer" ]] && error "Usage: isopod cache delete <layer-name>"

  _layer_exists "$layer" || error "Unknown layer: $layer. Run 'isopod cache list' to see available layers."

  _layer_delete_version "$layer"
  success "Stored hash for '$layer' deleted. Next build will treat it as stale."
}

cmd_cache_destroy() {
  header "Destroying cache"

  # Remove the workspace image
  if docker image inspect "$WORKSPACE_IMAGE" &>/dev/null 2>&1; then
    info "Removing workspace image..."
    docker rmi "$WORKSPACE_IMAGE" 2>&1 || warn "Could not remove image (may be in use by running containers)"
  else
    info "No workspace image found"
  fi

  # Remove cached hashes
  local cache_hash_dir="$DOCKER_DIR/.cache-hashes"
  if [[ -d "$cache_hash_dir" ]]; then
    info "Removing cached hashes..."
    rm -rf "$cache_hash_dir"
  fi

  # Clean up dangling images left behind
  docker image prune -f 2>/dev/null | grep -v "Total reclaimed space: 0B" || true

  success "Cache destroyed. Run 'isopod build' to rebuild."
}

cmd_cache() {
  local subcmd="${1:-list}"
  shift 2>/dev/null || true

  case "$subcmd" in
    list|ls) cmd_cache_list ;;
    rebuild) cmd_cache_rebuild "$@" ;;
    delete)  cmd_cache_delete "$@" ;;
    destroy) cmd_cache_destroy ;;
    help|--help|-h)
      echo ""
      echo "${BOLD}isopod cache${NC} — Manage build cache"
      echo ""
      echo "${BOLD}Subcommands:${NC}"
      echo "  ${BOLD}list${NC}                     Show all layers and their status"
      echo "  ${BOLD}rebuild${NC}  <layer>          Rebuild from a layer (cascades to later layers)"
      echo "  ${BOLD}delete${NC}   <layer>           Mark a layer as stale"
      echo "  ${BOLD}destroy${NC}                    Remove workspace image and all cached hashes"
      echo ""
      if [[ ${#LAYER_NAMES[@]} -gt 0 ]]; then
        echo "${BOLD}Layers:${NC}"
        for layer in "${LAYER_NAMES[@]}"; do
          echo "  $layer"
        done
        echo ""
      fi
      ;;
    *) error "Unknown cache subcommand: $subcmd. Run 'isopod cache help' for usage." ;;
  esac
}
