#!/bin/zsh
# commands/list.sh — List active pods

cmd_list() {
  header "Active pods"

  if [[ ! -d "$PODS_DIR" ]] || [[ -z "$(ls -A "$PODS_DIR" 2>/dev/null)" ]]; then
    echo "${DIM}  No pods. Create one with: isopod create <feature-name>${NC}"
    return 0
  fi

  # Primary workspace
  echo "${BOLD}  Primary${NC}"
  echo "${DIM}    Directory:${NC} $PROJECT_ROOT"
  for repo_name in "${ALL_REPO_DIRS[@]}"; do
    if [[ -d "$REPOS_DIR/$repo_name" ]]; then
      local branch=$(cd "$REPOS_DIR/$repo_name" && git branch --show-current 2>/dev/null || echo "unknown")
      printf "${DIM}    %-22s${NC} %s\n" "$repo_name:" "$branch"
    fi
  done
  echo ""

  # Fetch all container statuses in one call
  typeset -A container_statuses
  while IFS=$'\t' read -r cname cstatus; do
    [[ -n "$cname" ]] && container_statuses[$cname]="$cstatus"
  done < <(docker ps -a --format '{{.Names}}\t{{.Status}}' 2>/dev/null)

  # Pods
  for dir in "$PODS_DIR"/*/; do
    [[ -d "$dir" ]] || continue
    local name=$(basename "$dir")

    echo "${BOLD}  $name${NC} (🐳 container)"
    echo "${DIM}    Directory:${NC} $dir"

    for repo_name in "${ALL_REPO_DIRS[@]}"; do
      if [[ -d "$dir/$repo_name" ]]; then
        local branch=$(cd "$dir/$repo_name" && git branch --show-current 2>/dev/null || echo "unknown")
        printf "${DIM}    %-22s${NC} %s\n" "$repo_name:" "$branch"
      fi
    done

    local container=$(workspace_container "$name")
    local container_status="${container_statuses[$container]:-not running}"
    echo "${DIM}    Container:${NC}   $container_status"

    echo ""
  done
}
