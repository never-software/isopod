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

  # ── Step 0: Copy pod template if it exists ──
  local pod_template_dir="$PROJECT_ROOT/pod_template"
  if [[ -d "$pod_template_dir" ]]; then
    info "Copying pod template..."
    rsync -a "$pod_template_dir/" "$pod_dir/"
  fi

  # ── Step 1: Create local clones on the host ──
  if [[ -n "$from_branch" ]]; then
    info "Branching from: $from_branch"
  fi

  for repo_name in "${repos[@]}"; do
    info "Creating $repo_name workspace on branch $feature_name..."
    create_repo_clone "$REPOS_DIR/$repo_name" "$pod_dir/$repo_name" "$feature_name" "$from_branch"
  done

  # ── Step 2: Generate docker-compose file ──
  info "Generating docker-compose.yml..."
  
  # Build the dynamic volume definitions for the repos that actually exist
  local repo_volumes=""
  local repo_volumes_hook="$DOCKER_DIR/hooks/repo-volumes"
  for dir_name in "${repos[@]}"; do
    if [[ -d "$pod_dir/$dir_name" ]]; then
      repo_volumes="$repo_volumes      - ./$dir_name:/workspace/$dir_name:delegated"$'\n'
      # Delegate extra volumes (anonymous overlays, etc.) to project hook
      if [[ -x "$repo_volumes_hook" ]]; then
        local extra
        extra=$(REPO_NAME="$dir_name" POD_DIR="$pod_dir" "$repo_volumes_hook")
        if [[ -n "$extra" ]]; then
          repo_volumes="$repo_volumes$extra"$'\n'
        fi
      fi
    fi
  done

  # Strip the trailing newline from repo_volumes
  repo_volumes="${repo_volumes%$'\n'}"

  local compose_file="$pod_dir/docker-compose.yml"
  
  # Build comma-separated list of active repos for the container
  local repo_list="${(j:,:)repos}"

  # Inject the dynamic volumes using awk
  export VOLUMES="$repo_volumes"
  awk -v name="$feature_name" \
      -v docker_dir="$DOCKER_DIR" \
      -v image_name="$WORKSPACE_IMAGE" \
      -v repo_list="$repo_list" \
      '{
        if ($0 ~ "__REPO_VOLUMES__") {
          print ENVIRON["VOLUMES"]
        } else {
          gsub("__FEATURE_NAME__", name)
          gsub("__DOCKER_DIR__", docker_dir)
          gsub("__IMAGE_NAME__", image_name)
          gsub("__REPO_LIST__", repo_list)
          print $0
        }
      }' "$DOCKER_DIR/docker-compose.template.yml" > "$compose_file"

  # Copy .env files from main repos into pod (they're gitignored so won't exist)
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

  # ── Step 4: Start container (delegates to cmd_up) ──
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
