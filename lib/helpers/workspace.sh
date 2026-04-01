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
  [[ -x "$urls_hook" ]] || return 0

  local output
  output=$(FEATURE_NAME="$feature_name" "$urls_hook" 2>/dev/null) || return 0
  [[ -n "$output" ]] || return 0

  echo ""

  # Wait for the first URL (IDE/code-server) while showing container progress.
  # Run in a subshell with tracing off so variable assignments don't leak.
  local first_url
  first_url=$(echo "$output" | head -1 | cut -f2)

  (
    local elapsed=0
    local timeout=600
    local last_line=""
    local log_line=""

    while (( elapsed < timeout )); do
      if curl -sk --connect-timeout 2 --max-time 3 "$first_url" -o /dev/null 2>/dev/null; then
        break
      fi

      # Show the latest container log line as a status indicator
      log_line=$(docker logs --tail 1 "$feature_name" 2>/dev/null) || log_line=""
      if [[ -n "$log_line" ]] && [[ "$log_line" != "$last_line" ]]; then
        printf '\033[2K\r  \033[2m▸ %s\033[0m' "${log_line:0:100}"
        last_line="$log_line"
      fi

      sleep 3
      elapsed=$((elapsed + 3))
    done

    # Clear the status line
    printf '\033[2K\r'
  ) 2>/dev/null

  # Print final URL summary
  echo "${BOLD}Services:${NC}"
  echo "$output" | while IFS=$'\t' read -r label url; do
    if curl -sk --connect-timeout 2 --max-time 3 "$url" -o /dev/null 2>/dev/null; then
      printf "  ${DIM}%-14s${NC} ${CYAN}%s${NC}\n" "$label" "$url"
    else
      printf "  ${DIM}%-14s${NC} ${YELLOW}%s${NC} (not responding)\n" "$label" "$url"
    fi
  done
  echo ""
}
