#!/bin/zsh
# commands/exec.sh — Run a command inside a pod container

cmd_exec() {
  local feature_name="${1:-}"
  [[ -z "$feature_name" ]] && error "Usage: isopod exec <feature-name> <command...>"
  shift

  local pod_dir="$PODS_DIR/$feature_name"
  [[ ! -d "$pod_dir" ]] && error "Pod '$feature_name' not found"

  # Parse flags
  local workdir="/workspace"
  local remaining_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir|-C)
        workdir="$2"
        shift 2
        ;;
      *)
        remaining_args+=("$1")
        shift
        ;;
    esac
  done

  [[ ${#remaining_args[@]} -eq 0 ]] && error "No command specified. Usage: isopod exec <feature-name> <command...>"

  local container=$(workspace_container "$feature_name")

  # Check container is running
  docker inspect "$container" &>/dev/null 2>&1 || error "Container '$container' is not running. Start it with: isopod up $feature_name"

  # Detect TTY and set flags accordingly
  local tty_flags=""
  if [[ -t 0 ]]; then
    tty_flags="-it"
  else
    tty_flags="-i"
  fi

  # Run the command
  local exit_code=0
  docker exec $tty_flags -w "$workdir" "$container" "${remaining_args[@]}" || exit_code=$?

  return $exit_code
}
