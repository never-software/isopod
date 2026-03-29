#!/bin/zsh
# lib/workspace.sh — Workspace lifecycle hooks

setup_workspace() {
  local pod_dir="$1"
  local feature_name=$(basename "$pod_dir")

  local post_workspace_hook="$DOCKER_DIR/hooks/post-workspace"
  if [[ -x "$post_workspace_hook" ]]; then
    POD_DIR="$pod_dir" \
    FEATURE_NAME="$feature_name" \
      "$post_workspace_hook"
  fi

  success "Workspace ready"
}

teardown_workspace() {
  local feature_name="$1"

  local teardown_hook="$DOCKER_DIR/hooks/teardown-workspace"
  if [[ -x "$teardown_hook" ]]; then
    FEATURE_NAME="$feature_name" \
      "$teardown_hook" || true
  fi
}

display_urls() {
  local feature_name="$1"

  local urls_hook="$DOCKER_DIR/hooks/urls"
  if [[ -x "$urls_hook" ]]; then
    local output
    output=$(FEATURE_NAME="$feature_name" "$urls_hook" 2>/dev/null)
    if [[ -n "$output" ]]; then
      echo ""
      echo "${BOLD}Services:${NC}"
      echo "$output" | while IFS=$'\t' read -r label url; do
        # Wait for the service to respond before printing
        printf "  ${DIM}%-14s${NC} waiting..." "$label"
        local elapsed=0
        local timeout=120
        while (( elapsed < timeout )); do
          if curl -sk --connect-timeout 2 --max-time 3 "$url" -o /dev/null 2>/dev/null; then
            printf "\r\033[K  ${DIM}%-14s${NC} ${CYAN}%s${NC}\n" "$label" "$url"
            break
          fi
          sleep 2
          elapsed=$((elapsed + 2))
        done
        if (( elapsed >= timeout )); then
          printf "\r\033[K  ${DIM}%-14s${NC} ${YELLOW}%s${NC} (not responding)\n" "$label" "$url"
        fi
      done
      echo ""
    fi
  fi
}
