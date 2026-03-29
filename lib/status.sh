#!/bin/zsh
# commands/status.sh — Show container health

cmd_status() {
  local feature_name="${1:-}"

  require_docker

  if [[ -n "$feature_name" ]]; then
    # Status for a specific pod
    local pod_dir="$PODS_DIR/$feature_name"
    [[ ! -d "$pod_dir" ]] && error "Pod '$feature_name' not found"

    local compose_file=$(compose_file_for "$feature_name")
    local project=$(compose_project "$feature_name")

    header "$feature_name (🐳 container)"
    docker compose -p "$project" -f "$compose_file" ps --format "table {{.Service}}\t{{.State}}\t{{.Status}}" 2>/dev/null || \
      echo "${DIM}    Container not running${NC}"
  else
    # Status for all pods
    header "Pod container status"

    if [[ ! -d "$PODS_DIR" ]] || [[ -z "$(ls -A "$PODS_DIR" 2>/dev/null)" ]]; then
      echo "${DIM}  No pods.${NC}"
      return 0
    fi

    for dir in "$PODS_DIR"/*/; do
      [[ -d "$dir" ]] || continue
      local name=$(basename "$dir")

      local compose_file=$(compose_file_for "$name")
      local project=$(compose_project "$name")

      echo "${BOLD}  $name${NC} (🐳 container)"
      docker compose -p "$project" -f "$compose_file" ps --format "    {{.Service}}: {{.State}} ({{.Status}})" 2>/dev/null || \
        echo "${DIM}    Container not running${NC}"
      echo ""
    done
  fi
}
