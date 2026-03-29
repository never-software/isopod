#!/bin/zsh
# commands/enter.sh — Open an interactive shell inside a pod container

cmd_enter() {
  local feature_name="${1:-}"
  [[ -z "$feature_name" ]] && error "Usage: isopod enter <feature-name>"

  local pod_dir="$PODS_DIR/$feature_name"
  [[ ! -d "$pod_dir" ]] && error "Pod '$feature_name' not found"

  local container=$(workspace_container "$feature_name")

  # Check container is running
  docker inspect "$container" &>/dev/null 2>&1 || error "Container '$container' is not running. Start it with: isopod up $feature_name"

  # Prefer bash, fall back to sh
  local shell="/bin/bash"
  docker exec "$container" test -x /bin/bash &>/dev/null 2>&1 || shell="/bin/sh"
  exec docker exec -it -w /workspace "$container" "$shell"
}
