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

  # Sync home template into pod (creates on first up, updates on subsequent)
  local home_template_dir="$PROJECT_ROOT/pod_home_template"
  if [[ -d "$home_template_dir" ]]; then
    mkdir -p "$pod_dir/.home"
    rsync -a "$home_template_dir/" "$pod_dir/.home/"
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
