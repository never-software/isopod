#!/bin/zsh
# lib/docker.sh — Docker helpers: daemon, compose, image build, cleanup

# Check Docker is available and running
require_docker() {
  command -v docker &>/dev/null || error "Docker is not installed. Install Docker Desktop or OrbStack first."
  
  if ! docker info &>/dev/null 2>&1; then
    # Prefer OrbStack if installed, fall back to Docker Desktop
    if [ -d "/Applications/OrbStack.app" ]; then
      info "Starting OrbStack..."
      open -a OrbStack
    elif [ -d "/Applications/Docker.app" ]; then
      info "Starting Docker Desktop..."
      open -a Docker
    fi
    
    # Wait for Docker daemon to respond
    local timeout=60
    local interval=2
    local docker_ready=false
    
    echo -n "${DIM}  Waiting for Docker daemon to start...${NC}"
    for ((t=0; t<timeout; t+=interval)); do
      if docker info &>/dev/null 2>&1; then
        docker_ready=true
        break
      fi
      echo -n "."
      sleep "$interval"
    done
    echo ""
    
    if [[ "$docker_ready" != "true" ]]; then
      error "Docker daemon failed to start after ${timeout}s. Please start Docker manually."
    else
      success "Docker daemon running"
    fi
  fi
}

# Get the Docker Compose project name for a feature
compose_project() {
  echo "isopod-${1}"
}

# Get path to the pod's docker-compose file
compose_file_for() {
  echo "$PODS_DIR/$1/docker-compose.yml"
}

# Get the workspace container name for a feature
workspace_container() {
  echo "${1}"
}

# Generate (or regenerate) docker-compose.yml for a pod from the current template.
# Detects repos from the pod directory automatically.
generate_compose() {
  local feature_name="$1"
  local pod_dir="$PODS_DIR/$feature_name"

  # Detect repos from pod directory (directories with .git)
  local repos=()
  for dir in "$pod_dir"/*/; do
    [[ -d "$dir/.git" ]] && repos+=("$(basename "$dir")")
  done

  local repo_volumes=""
  local repo_volumes_hook="$DOCKER_DIR/hooks/repo-volumes"
  for dir_name in "${repos[@]}"; do
    if [[ -d "$pod_dir/$dir_name" ]]; then
      repo_volumes="$repo_volumes      - ./$dir_name:/workspace/$dir_name:delegated"$'\n'
      if [[ -x "$repo_volumes_hook" ]]; then
        local extra="$(REPO_NAME="$dir_name" POD_DIR="$pod_dir" "$repo_volumes_hook")"
        if [[ -n "$extra" ]]; then
          repo_volumes="$repo_volumes$extra"$'\n'
        fi
      fi
    fi
  done
  repo_volumes="${repo_volumes%$'\n'}"

  local compose_file="$pod_dir/docker-compose.yml"
  local repo_list="${(j:,:)repos}"

  # Generate home template volume mounts (live bind mounts from source)
  local home_volumes=""
  local home_template_dir="$PROJECT_ROOT/pod_home_template"
  if [[ -d "$home_template_dir" ]]; then
    for item in "$home_template_dir"/*(DN); do
      [[ -e "$item" ]] || continue
      local name=$(basename "$item")
      home_volumes="${home_volumes}      - ${item}:/root/${name}:delegated"$'\n'
      home_volumes="${home_volumes}      - ${item}:/home/dev/${name}:delegated"$'\n'
    done
    home_volumes="${home_volumes%$'\n'}"
  fi

  # Generate workspace template volume mounts (live bind mounts from source)
  local workspace_template_volumes=""
  local workspace_template_dir="$PROJECT_ROOT/pod_workspace_template"
  if [[ -d "$workspace_template_dir" ]]; then
    for item in "$workspace_template_dir"/*(DN); do
      [[ -e "$item" ]] || continue
      local name=$(basename "$item")
      [[ "$name" == ".gitkeep" ]] && continue
      workspace_template_volumes="${workspace_template_volumes}      - ${item}:/workspace/${name}:delegated"$'\n'
    done
    workspace_template_volumes="${workspace_template_volumes%$'\n'}"
  fi

  export VOLUMES="$repo_volumes"
  export HOME_TEMPLATE_VOLUMES="$home_volumes"
  export WORKSPACE_TEMPLATE_VOLUMES="$workspace_template_volumes"
  awk -v name="$feature_name" \
      -v docker_dir="$DOCKER_DIR" \
      -v image_name="$WORKSPACE_IMAGE" \
      -v repo_list="$repo_list" \
      '{
        if ($0 ~ "__REPO_VOLUMES__") {
          print ENVIRON["VOLUMES"]
        } else if ($0 ~ "__HOME_TEMPLATE_VOLUMES__") {
          if (ENVIRON["HOME_TEMPLATE_VOLUMES"] != "") print ENVIRON["HOME_TEMPLATE_VOLUMES"]
        } else if ($0 ~ "__WORKSPACE_TEMPLATE_VOLUMES__") {
          if (ENVIRON["WORKSPACE_TEMPLATE_VOLUMES"] != "") print ENVIRON["WORKSPACE_TEMPLATE_VOLUMES"]
        } else {
          gsub("__FEATURE_NAME__", name)
          gsub("__DOCKER_DIR__", docker_dir)
          gsub("__IMAGE_NAME__", image_name)
          gsub("__REPO_LIST__", repo_list)
          print $0
        }
      }' "$DOCKER_DIR/docker-compose.template.yml" > "$compose_file"
}

# Resilient docker compose up with automatic retry on port conflicts.
# Docker can leave phantom port bindings after a failed container start.
# This helper catches that error, does a full "down --remove-orphans" to release
# the stuck port, waits briefly, and retries.
compose_up() {
  local project="$1"
  local compose_file="$2"
  local max_retries=3
  local attempt=1
  local output=""

  while [[ $attempt -le $max_retries ]]; do
    output=$(docker compose -p "$project" -f "$compose_file" up -d 2>&1) && {
      return 0
    }

    if echo "$output" | grep -q "ports are not available\|address already in use\|port is already allocated"; then
      warn "Port conflict detected (attempt $attempt/$max_retries) — cleaning up and retrying..."
      docker compose -p "$project" -f "$compose_file" down --remove-orphans >/dev/null 2>&1 || true
      sleep 3
      attempt=$((attempt + 1))
    else
      echo "$output" >&2
      return 1
    fi
  done

  error "Failed to start container after $max_retries attempts due to port conflicts."
}

# Wait for a container to become reachable.
# Usage: wait_for_container <name> [timeout_seconds]
wait_for_container() {
  local container="$1"
  local timeout="${2:-30}"

  info "Waiting for container..."
  for ((t=0; t<timeout; t+=2)); do
    if docker exec "$container" true &>/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  warn "Container '$container' not reachable after ${timeout}s — continuing anyway"
}

# Image name: <project-dir>-workspace
PROJECT_NAME=$(basename "$PROJECT_ROOT")
WORKSPACE_IMAGE="${PROJECT_NAME}-workspace"

# Fetch latest default branch for all repos (used before building image)
fetch_latest_main() {
  info "Fetching latest default branch for all repos..."
  for repo_dir in "$REPOS_DIR"/*/; do
    local repo_name=$(basename "$repo_dir")
    if [[ -d "$repo_dir/.git" ]]; then
      if ! (cd "$repo_dir" && git remote get-url origin &>/dev/null); then
        info "  Skipping $repo_name (no remote)"
        continue
      fi

      # Try to fetch — if the remote is unreachable, skip gracefully
      if ! (cd "$repo_dir" && git fetch origin 2>&1); then
        warn "  Could not reach remote for $repo_name — skipping"
        continue
      fi

      # Detect default branch
      local default_branch
      default_branch=$(default_branch_for "$repo_dir")
      if [[ -z "$default_branch" ]]; then
        warn "  Could not determine default branch for $repo_name — skipping"
        continue
      fi
      (cd "$repo_dir" && git checkout "$default_branch" 2>&1 && git reset --hard "origin/$default_branch" 2>&1) || \
        warn "  Failed to update $default_branch for $repo_name"
    fi
  done
  success "All repos on latest default branch"
}

# Run cache-hooks and collect their output.
# Hooks output Dockerfile instructions to stdout.
# Hooks handle their own staleness detection, cleanup, and warnings via stderr.
_run_cache_hooks() {
  local cache_hooks_dir="$DOCKER_DIR/cache-hooks"

  CACHE_HOOK_INSTRUCTIONS=""
  if [[ -d "$cache_hooks_dir" ]] && [[ -x "$cache_hooks_dir/all.sh" ]]; then
    CACHE_HOOK_INSTRUCTIONS=$(
      REPOS_DIR="$REPOS_DIR" \
      DOCKER_DIR="$DOCKER_DIR" \
      PROJECT_ROOT="$PROJECT_ROOT" \
      WORKSPACE_IMAGE="$WORKSPACE_IMAGE" \
        "$cache_hooks_dir/all.sh"
    )
  fi
}

# Generate a Dockerfile with cache-hook instructions injected.
_generate_dockerfile() {
  local dockerfile="$DOCKER_DIR/workspace.Dockerfile"
  local generated="$PROJECT_ROOT/.generated.Dockerfile"

  _run_cache_hooks

  if [[ -n "$CACHE_HOOK_INSTRUCTIONS" ]]; then
    local deps_file=$(mktemp)
    echo "$CACHE_HOOK_INSTRUCTIONS" > "$deps_file"
    while IFS= read -r line; do
      if [[ "$line" == *"__CACHE_HOOK_INSTRUCTIONS__"* ]]; then
        cat "$deps_file"
      else
        echo "$line"
      fi
    done < "$dockerfile" > "$generated"
    rm -f "$deps_file"
  else
    sed '/__CACHE_HOOK_INSTRUCTIONS__/d' "$dockerfile" > "$generated"
  fi

  echo "$generated"
}

# Build the workspace image by delegating to the project's build script
build_image() {
  local build_script="$DOCKER_DIR/build.sh"

  info "Generating Dockerfile from cache-hooks..."
  local generated_dockerfile
  generated_dockerfile=$(_generate_dockerfile)

  if [[ ! -x "$build_script" ]]; then
    info "Building workspace image..."
    docker build \
      -f "$generated_dockerfile" \
      -t "$WORKSPACE_IMAGE" \
      "$PROJECT_ROOT" 2>&1
  else
    info "Building workspace image (via build.sh)..."
    DOCKER_DIR="$DOCKER_DIR" \
    PROJECT_ROOT="$PROJECT_ROOT" \
    WORKSPACE_IMAGE="$WORKSPACE_IMAGE" \
    REPOS_DIR="$REPOS_DIR" \
    GENERATED_DOCKERFILE="$generated_dockerfile" \
      "$build_script"
  fi

  rm -f "$generated_dockerfile"
  success "Workspace image built"

  # Save layer hashes so we can detect staleness later
  _layers_save_all

  docker_cleanup
}

# Clean up dangling Docker images to prevent disk bloat.
# Does NOT prune volumes — snapshot and pod data volumes must be preserved.
docker_cleanup() {
  info "Cleaning up dangling images..."
  docker image prune -f 2>/dev/null | grep -v "Total reclaimed space: 0B" || true
  success "Docker cleanup complete"
}

# Build everything: fetch main → build image
build_all() {
  fetch_latest_main
  build_image
}

# Build the workspace image if it doesn't exist.
# Also runs cache-hooks to surface any warnings.
ensure_image() {
  if ! docker image inspect "$WORKSPACE_IMAGE" &>/dev/null 2>&1; then
    info "Workspace image not found — building..."
    build_all
    return
  fi

  _run_cache_hooks
  success "Workspace image up to date"
}

