#!/bin/zsh
# commands/up.sh — Start or refresh a pod container

cmd_up() {
  local feature_name="${1:-}"
  [[ -z "$feature_name" ]] && error "Usage: isopod up <feature-name>"

  local pod_dir="$PODS_DIR/$feature_name"
  [[ ! -d "$pod_dir" ]] && error "Pod '$feature_name' not found"

  require_docker

  local compose_file=$(compose_file_for "$feature_name")
  local project=$(compose_project "$feature_name")

  header "Bringing up workspace for: $feature_name"

  ensure_image

  # Offer to clone base database if pod's data volume is empty
  local base_vol="isopod-base-data"
  local pod_vol="${project}_data"
  if docker volume inspect "$base_vol" &>/dev/null 2>&1; then
    local vol_empty=true
    if docker volume inspect "$pod_vol" &>/dev/null 2>&1; then
      if docker run --rm -v "$pod_vol":/pgdata alpine test -f /pgdata/PG_VERSION 2>/dev/null; then
        vol_empty=false
      fi
    fi
    if [[ "$vol_empty" == "true" ]]; then
      echo ""
      printf "${YELLOW}⚠${NC} This pod has no database. A fresh seed is available.\n"
      printf "  Clone base database into this pod? ${BOLD}[Y/n]${NC} "
      read -r answer
      if [[ "$answer" != "n" && "$answer" != "N" ]]; then
        info "Cloning base database..."
        docker volume rm "$pod_vol" 2>/dev/null || true
        docker volume create "$pod_vol" >/dev/null
        docker run --rm -v "$base_vol":/from -v "$pod_vol":/to "$WORKSPACE_IMAGE" bash -c "cp -a /from/. /to/"
        success "Database cloned from base"
      fi
    fi
  fi

  generate_compose "$feature_name"

  info "Starting container..."
  compose_up "$project" "$compose_file"

  local container=$(workspace_container "$feature_name")
  wait_for_container "$container"

  # Run project-specific post-up hook if it exists
  local post_up_hook="$DOCKER_DIR/hooks/post-up"
  if [[ -x "$post_up_hook" ]]; then
    info "Running post-up hook..."
    CONTAINER="$container" \
    POD_DIR="$pod_dir" \
    FEATURE_NAME="$feature_name" \
    COMPOSE_FILE="$compose_file" \
    COMPOSE_PROJECT="$project" \
      "$post_up_hook"
  fi

  setup_workspace "$pod_dir"

  success "Up complete"

  display_urls "$feature_name"
}
