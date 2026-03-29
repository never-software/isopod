#!/bin/zsh
# commands/info.sh — Show full system overview: pods, volumes, and cache

cmd_info() {
  require_docker

  # ── Pods & Containers ───────────────────────────────────────────────────────
  header "Pods & Containers"

  if [[ ! -d "$PODS_DIR" ]] || [[ -z "$(ls -A "$PODS_DIR" 2>/dev/null)" ]]; then
    echo "  ${DIM}No pods.${NC}"
  else
    # Fetch all container statuses in one call
    typeset -A container_statuses
    while IFS=$'\t' read -r cname cstatus; do
      [[ -n "$cname" ]] && container_statuses[$cname]="$cstatus"
    done < <(docker ps -a --format '{{.Names}}\t{{.Status}}' 2>/dev/null)

    for dir in "$PODS_DIR"/*/; do
      [[ -d "$dir" ]] || continue
      local name=$(basename "$dir")
      local container=$(workspace_container "$name")
      local cstate="${container_statuses[$container]:-}"

      # Color the status
      local status_color="$DIM"
      if [[ -z "$cstate" ]]; then
        cstate="no container"
      elif [[ "$cstate" == *"Up"* ]]; then
        status_color="$GREEN"
      elif [[ "$cstate" == *"Exited"* ]]; then
        status_color="$YELLOW"
      elif [[ "$cstate" == *"Created"* ]]; then
        status_color="$YELLOW"
      else
        status_color="$RED"
      fi

      printf "  ${BOLD}%-24s${NC} ${status_color}%s${NC}\n" "$name" "$cstate"

      for repo_name in "${ALL_REPO_DIRS[@]}"; do
        if [[ -d "$dir/$repo_name" ]]; then
          local branch=$(cd "$dir/$repo_name" && git branch --show-current 2>/dev/null || echo "unknown")
          printf "    ${DIM}%-20s${NC} %s\n" "$repo_name:" "$branch"
        fi
      done
    done
  fi

  # ── Volumes ─────────────────────────────────────────────────────────────────
  header "Volumes"

  # Pod data volumes
  local pod_volumes=($(docker volume ls --format '{{.Name}}' --filter "name=isopod-" 2>/dev/null | grep "_data$"))
  local snap_volumes=($(docker volume ls --format '{{.Name}}' --filter "name=isopod-snap-" 2>/dev/null))

  if [[ ${#pod_volumes[@]} -eq 0 ]] && [[ ${#snap_volumes[@]} -eq 0 ]]; then
    echo "  ${DIM}No isopod volumes.${NC}"
  else
    if [[ ${#pod_volumes[@]} -gt 0 ]]; then
      echo "  ${BOLD}Pod data:${NC}"
      for vol in "${pod_volumes[@]}"; do
        local created=$(docker volume inspect --format '{{.CreatedAt}}' "$vol" 2>/dev/null | cut -d'T' -f1)
        printf "    %-40s  %s\n" "$vol" "$created"
      done
    fi

    if [[ ${#snap_volumes[@]} -gt 0 ]]; then
      echo "  ${BOLD}Snapshots:${NC}"
      for vol in "${snap_volumes[@]}"; do
        local snap_name="${vol#isopod-snap-}"
        local created=$(docker volume inspect --format '{{.CreatedAt}}' "$vol" 2>/dev/null | cut -d'T' -f1)
        printf "    %-40s  %s\n" "$snap_name" "$created"
      done
    fi
  fi

  # ── Cache ───────────────────────────────────────────────────────────────────
  header "Cache"

  if docker image inspect "$WORKSPACE_IMAGE" &>/dev/null 2>&1; then
    local image_size=$(docker image inspect "$WORKSPACE_IMAGE" --format '{{.Size}}' 2>/dev/null)
    local image_created=$(docker image inspect "$WORKSPACE_IMAGE" --format '{{.Created}}' 2>/dev/null | cut -d'T' -f1)
    local image_size_mb=$((image_size / 1024 / 1024))
    echo "  ${BOLD}Image:${NC}  $WORKSPACE_IMAGE (${image_size_mb}MB, built $image_created)"
  else
    echo "  ${BOLD}Image:${NC}  not built"
  fi

  # Show all layers with status
  echo ""
  printf "  ${BOLD}%-4s %-16s %-14s %s${NC}\n" "#" "LAYER" "VERSION" "STATUS"

  local idx=1
  for layer in "${LAYER_NAMES[@]}"; do
    local version=$(_layer_current_version "$layer")
    local layer_st=$(_layer_status "$layer")

    local color="$GREEN"
    if [[ "$layer_st" == "stale" ]]; then
      color="$YELLOW"
    elif [[ "$layer_st" == "not built" ]]; then
      color="$DIM"
    fi

    printf "  %-4s %-16s %-14s %b\n" "$idx" "$layer" "$version" "${color}${layer_st}${NC}"
    idx=$((idx + 1))
  done
  echo ""
}
