#!/bin/zsh
# commands/down.sh — Stop a pod container (preserves data)

cmd_down() {
  local feature_name="${1:-}"
  [[ -z "$feature_name" ]] && error "Usage: isopod down <feature-name>"

  local pod_dir="$PODS_DIR/$feature_name"
  [[ ! -d "$pod_dir" ]] && error "Pod '$feature_name' not found"

  require_docker

  # Tear down workspace resources (hooks)
  teardown_workspace "$feature_name"
  success "Workspace '$feature_name' cleaned up"

  local compose_file=$(compose_file_for "$feature_name")
  local project=$(compose_project "$feature_name")

  info "Stopping container for: $feature_name..."
  docker compose -p "$project" -f "$compose_file" stop 2>&1
  success "Container stopped (data preserved). Use 'isopod up $feature_name' to restart."
}
