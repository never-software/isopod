#!/bin/zsh
# commands/create.sh — Create a new pod with container

cmd_create() {
  local feature_name="${1:-}"
  shift 2>/dev/null || true
  local args=("$@")

  [[ -z "$feature_name" ]] && error "Usage: isopod create <feature-name> [repos...] [--from <branch>]"

  # Parse flags
  local from_branch=""
  local repos=()
  local expect_from=false
  for arg in "${args[@]}"; do
    if [[ "$expect_from" == "true" ]]; then
      from_branch="$arg"
      expect_from=false
      continue
    fi
    case "$arg" in
      --from)
        expect_from=true
        ;;
      *)
        repos+=("$arg")
        ;;
    esac
  done
  [[ "$expect_from" == "true" ]] && error "--from requires a branch name"

  # Expand 'all' to all available repos
  if [[ ${#repos[@]} -eq 1 ]] && [[ "${repos[1]}" == "all" ]]; then
    repos=("${ALL_REPO_DIRS[@]}")
  fi

  # Default to all repos if none specified
  if [[ ${#repos[@]} -eq 0 ]]; then
    repos=("${ALL_REPO_DIRS[@]}")
  fi

  # Validate repo names
  local validated=()
  for repo in "${repos[@]}"; do
    local canonical=$(resolve_repo "$repo")
    if [[ -n "$canonical" ]]; then
      validated+=("$canonical")
    else
      warn "Unknown repo '$repo' — expected one of: ${ALL_REPO_DIRS[*]}"
    fi
  done
  repos=("${validated[@]}")

  local pod_dir="$PODS_DIR/$feature_name"
  [[ -d "$pod_dir" ]] && error "Pod '$feature_name' already exists at $pod_dir"

  cmd_create_container "$feature_name" "$from_branch" "${repos[@]}"
}

cmd_create_container() {
  local feature_name="$1"
  local from_branch="$2"
  shift 2
  local repos=("$@")

  require_docker

  local pod_dir="$PODS_DIR/$feature_name"

  header "Creating pod: $feature_name"

  mkdir -p "$pod_dir"

  # ── Step 1: Create local clones on the host ──
  if [[ -n "$from_branch" ]]; then
    info "Branching from: $from_branch"
  fi

  for repo_name in "${repos[@]}"; do
    info "Creating $repo_name workspace on branch $feature_name..."
    create_repo_clone "$REPOS_DIR/$repo_name" "$pod_dir/$repo_name" "$feature_name" "$from_branch"
  done

  # ── Step 2: Copy .env files from main repos into pod (they're gitignored so won't exist) ──
  for dir_name in "${repos[@]}"; do
    if [[ -d "$REPOS_DIR/$dir_name" ]] && [[ -d "$pod_dir/$dir_name" ]]; then
      (cd "$REPOS_DIR/$dir_name" && find . -name ".env" -not -path "*/node_modules/*" -not -path "*/.git/*") | while read -r env_file; do
        local src="$REPOS_DIR/$dir_name/$env_file"
        local dst="$pod_dir/$dir_name/$env_file"
        if [[ -f "$src" ]]; then
          mkdir -p "$(dirname "$dst")"
          cp "$src" "$dst"
        fi
      done
    fi
  done

  # ── Step 3: Run pre-create hook ──
  local project=$(compose_project "$feature_name")

  local pre_create_hook="$DOCKER_DIR/hooks/pre-create"
  if [[ -x "$pre_create_hook" ]]; then
    info "Running pre-create hook..."
    COMPOSE_PROJECT="$project" \
    WORKSPACE_IMAGE="$WORKSPACE_IMAGE" \
    POD_DIR="$pod_dir" \
    FEATURE_NAME="$feature_name" \
      "$pre_create_hook"
  fi

  # ── Step 4: Start container (delegates to cmd_up, which generates compose) ──
  cmd_up "$feature_name"

  # ── Step 5: Run one-time post-create hook ──
  local container="${feature_name}"
  local post_create_hook="$DOCKER_DIR/hooks/post-create"
  if [[ -x "$post_create_hook" ]]; then
    info "Running post-create hook..."
    CONTAINER="$container" \
    POD_DIR="$pod_dir" \
    FEATURE_NAME="$feature_name" \
      "$post_create_hook"
  fi

  # ── Done ──
  header "Done! 🚀"
  echo "${BOLD}Pod directory:${NC} $pod_dir"
  echo ""
  echo "${DIM}Edit files locally:${NC}"
  echo "  ${CYAN}code $pod_dir${NC}"
  echo ""
  echo "${DIM}Run commands in container:${NC}"
  echo "  ${CYAN}isopod exec $feature_name <command>${NC}"
  echo ""
}
