#!/bin/zsh
# commands/setup.sh — Interactive first-time setup wizard

# ── Helpers ───────────────────────────────────────────────────────────────────

_setup_step=0

_step() {
  _setup_step=$((_setup_step + 1))
  header "Step $_setup_step: $1"
}

_ask() {
  printf "  ${BOLD}$1${NC} [Y/n] "
  read -r answer
  [[ "$answer" != "n" && "$answer" != "N" ]]
}

_check() {
  local label="$1"
  shift
  if "$@" &>/dev/null 2>&1; then
    success "$label"
    return 0
  else
    warn "$label — not found"
    return 1
  fi
}

# ── Step 1: Prerequisites ────────────────────────────────────────────────────

_setup_prerequisites() {
  _step "Prerequisites"

  [[ "$(uname)" == "Darwin" ]] || error "isopod currently requires macOS"

  local has_brew=false
  command -v brew &>/dev/null && has_brew=true

  # Docker
  if command -v docker &>/dev/null; then
    if [[ -d "/Applications/OrbStack.app" ]]; then
      success "OrbStack"
    elif [[ -d "/Applications/Docker.app" ]]; then
      success "Docker Desktop"
    else
      success "Docker CLI"
    fi
  else
    warn "Docker runtime not found"
    info "Install OrbStack: https://orbstack.dev/"
    if [[ "$has_brew" == "true" ]]; then
      _ask "Install OrbStack via Homebrew?" && brew install orbstack
    fi
  fi

  # mkcert
  if command -v mkcert &>/dev/null; then
    success "mkcert"
  else
    warn "mkcert — not found (needed for trusted HTTPS)"
    if [[ "$has_brew" == "true" ]]; then
      _ask "Install mkcert?" && { brew install mkcert && mkcert -install; }
    else
      info "Install: https://github.com/FiloSottile/mkcert"
    fi
  fi

  # jq (optional)
  if command -v jq &>/dev/null; then
    success "jq"
  else
    info "jq not found (optional — brew install jq)"
  fi
}

# ── Step 2: Docker configuration ─────────────────────────────────────────────

_setup_docker_local() {
  _step "Docker configuration"

  if [[ -d "$PROJECT_ROOT/docker.local" ]]; then
    success "docker.local/ already exists"
    return 0
  fi

  if [[ -d "$PROJECT_ROOT/examples/rails-react" ]]; then
    echo ""
    echo "  ${BOLD}1)${NC} Start from blank scaffold (docker/)"
    echo "  ${BOLD}2)${NC} Start from Rails + React example"
    echo ""
    printf "  ${BOLD}Choose [1/2]:${NC} "
    read -r choice
    case "$choice" in
      2)
        cp -r "$PROJECT_ROOT/examples/rails-react/docker.local" "$PROJECT_ROOT/docker.local"
        if [[ ! -d "$PROJECT_ROOT/repos/example-api" ]]; then
          cp -r "$PROJECT_ROOT/examples/rails-react/repos/"* "$PROJECT_ROOT/repos/"
        fi
        success "docker.local/ created from Rails + React example"
        ;;
      *)
        cp -r "$PROJECT_ROOT/docker" "$PROJECT_ROOT/docker.local"
        success "docker.local/ created from scaffold"
        ;;
    esac
  else
    cp -r "$PROJECT_ROOT/docker" "$PROJECT_ROOT/docker.local"
    success "docker.local/ created from scaffold"
  fi

  # Update DOCKER_DIR for subsequent steps
  DOCKER_DIR="$PROJECT_ROOT/docker.local"
}

# ── Step 3: SSH keys ─────────────────────────────────────────────────────────

_setup_ssh() {
  _step "SSH keys"

  local ssh_dir="$DOCKER_DIR/ssh"
  if [[ -d "$ssh_dir" ]] && ls "$ssh_dir"/*pub &>/dev/null 2>&1; then
    success "SSH keys already configured in docker.local/ssh/"
    # Still ensure host agent has keys loaded
    for key in "$ssh_dir"/*; do
      [[ -f "$key" && "$key" != *.pub && "$(basename "$key")" != "known_hosts" && "$(basename "$key")" != "config" ]] && ssh-add "$key" 2>/dev/null || true
    done
    return 0
  fi

  # Discover keys
  local keys=()
  for pub in ~/.ssh/*.pub; do
    [[ -f "$pub" ]] || continue
    local priv="${pub%.pub}"
    [[ -f "$priv" ]] || continue
    # Skip default or agent-related files
    local name=$(basename "$priv")
    [[ "$name" == "known_hosts" || "$name" == "config" || "$name" == "authorized_keys" ]] && continue
    keys+=("$priv")
  done

  if [[ ${#keys[@]} -eq 0 ]]; then
    warn "No SSH keys found in ~/.ssh/"
    info "Generate one with: ssh-keygen -t ed25519"
    return 0
  fi

  echo ""
  echo "  Found SSH keys:"
  local i=1
  for key in "${keys[@]}"; do
    local name=$(basename "$key")
    local comment=$(ssh-keygen -l -f "$key" 2>/dev/null | awk '{print $3}')
    echo "    ${BOLD}$i)${NC} $name ${DIM}($comment)${NC}"
    i=$((i + 1))
  done
  echo "    ${BOLD}$i)${NC} All of the above"
  echo "    ${BOLD}0)${NC} Skip — I'll configure SSH later"
  echo ""

  printf "  ${BOLD}Select keys for containers (e.g. 1,2 or 3):${NC} "
  read -r selection

  [[ "$selection" == "0" || -z "$selection" ]] && { info "Skipping SSH setup"; return 0; }

  # Parse selection
  local selected=()
  if [[ "$selection" == "$i" ]]; then
    selected=("${keys[@]}")
  else
    IFS=',' read -ra indices <<< "$selection"
    for idx in "${indices[@]}"; do
      idx=$(echo "$idx" | tr -d ' ')
      if [[ "$idx" -ge 1 && "$idx" -le ${#keys[@]} ]]; then
        selected+=("${keys[$idx]}")
      fi
    done
  fi

  if [[ ${#selected[@]} -eq 0 ]]; then
    warn "No valid keys selected"
    return 0
  fi

  # Create ssh directory
  local ssh_dir="$DOCKER_DIR/ssh"
  mkdir -p "$ssh_dir"

  # Copy selected keys
  for key in "${selected[@]}"; do
    local name=$(basename "$key")
    cp "$key" "$ssh_dir/$name"
    [[ -f "$key.pub" ]] && cp "$key.pub" "$ssh_dir/$name.pub"
    chmod 600 "$ssh_dir/$name"
    success "Copied $name"
  done

  # Generate known_hosts
  info "Fetching known host keys..."
  ssh-keyscan github.com gitlab.com bitbucket.org 2>/dev/null > "$ssh_dir/known_hosts"
  success "known_hosts populated"

  # Generate SSH config
  if [[ ${#selected[@]} -eq 1 ]]; then
    local keyname=$(basename "${selected[1]}")
    cat > "$ssh_dir/config" <<EOF
Host github.com
  IdentityFile ~/.ssh/$keyname
  IdentitiesOnly yes
EOF
    success "SSH config created (single key)"
  else
    echo ""
    info "Multiple keys detected — let's set up Git host routing."
    echo ""
    local ssh_config=""
    for key in "${selected[@]}"; do
      local keyname=$(basename "$key")
      echo "  ${BOLD}$keyname${NC}:"
      printf "    GitHub org/user this key is for (or press Enter to skip): "
      read -r org
      if [[ -n "$org" ]]; then
        local alias="github.com-$keyname"
        ssh_config+="Host $alias\n  HostName github.com\n  IdentityFile ~/.ssh/$keyname\n  IdentitiesOnly yes\n\n"

        # Build gitconfig rewrite rule
        if [[ ! -f "$DOCKER_DIR/gitconfig" ]]; then
          echo "[user]" > "$DOCKER_DIR/gitconfig"
          echo "" >> "$DOCKER_DIR/gitconfig"
        fi
        echo "[url \"git@$alias:$org/\"]" >> "$DOCKER_DIR/gitconfig"
        echo "    insteadOf = git@github.com:$org/" >> "$DOCKER_DIR/gitconfig"
        echo "" >> "$DOCKER_DIR/gitconfig"
        success "  $keyname → github.com:$org/"
      fi
    done
    if [[ -n "$ssh_config" ]]; then
      echo -e "$ssh_config" > "$ssh_dir/config"
      success "SSH config and gitconfig created"
    fi
  fi

  # Ensure SSH agent has keys loaded
  echo ""
  info "Loading selected keys into SSH agent..."
  for key in "${selected[@]}"; do
    ssh-add "$key" 2>/dev/null || true
  done

  # Add to macOS SSH config for auto-loading
  local host_ssh_config="$HOME/.ssh/config"
  if ! grep -q "AddKeysToAgent" "$host_ssh_config" 2>/dev/null; then
    _ask "Add 'AddKeysToAgent yes' to ~/.ssh/config so keys auto-load on reboot?" && {
      local block="Host *\n  AddKeysToAgent yes\n  UseKeychain yes\n"
      for key in "${selected[@]}"; do
        block+="  IdentityFile $key\n"
      done
      # Insert after OrbStack include if present, otherwise at top
      if grep -q "OrbStack" "$host_ssh_config" 2>/dev/null; then
        local orbstack_end=$(grep -n "OrbStack" "$host_ssh_config" | tail -1 | cut -d: -f1)
        local include_line=$(tail -n +"$orbstack_end" "$host_ssh_config" | grep -n "^Include" | head -1 | cut -d: -f1)
        local insert_after=$((orbstack_end + include_line))
        local tmpfile=$(mktemp)
        head -n "$insert_after" "$host_ssh_config" > "$tmpfile"
        echo "" >> "$tmpfile"
        echo -e "$block" >> "$tmpfile"
        tail -n +"$((insert_after + 1))" "$host_ssh_config" >> "$tmpfile"
        mv "$tmpfile" "$host_ssh_config"
      else
        local tmpfile=$(mktemp)
        echo -e "$block" > "$tmpfile"
        echo "" >> "$tmpfile"
        cat "$host_ssh_config" >> "$tmpfile" 2>/dev/null
        mv "$tmpfile" "$host_ssh_config"
      fi
      chmod 600 "$host_ssh_config"
      success "~/.ssh/config updated — keys will auto-load after reboot"
    }
  else
    success "~/.ssh/config already has AddKeysToAgent"
  fi
}

# ── Step 4: HTTPS certificates ───────────────────────────────────────────────

_setup_certs() {
  _step "HTTPS certificates"

  local certs_dir="$DOCKER_DIR/certs"
  mkdir -p "$certs_dir"

  if ls "$certs_dir"/*.pem &>/dev/null 2>&1; then
    success "Certificates already exist"
    return 0
  fi

  if ! command -v mkcert &>/dev/null; then
    warn "mkcert not available — skipping"
    info "Install mkcert and run: cd docker.local/certs && mkcert '*.orb.local' localhost 127.0.0.1"
    return 0
  fi

  info "Generating trusted certificates..."
  (cd "$certs_dir" && mkcert "*.orb.local" localhost 127.0.0.1)
  success "Certificates generated"
  warn "Restart Chrome (Cmd+Q) for the new CA to take effect"
}

# ── Step 5: First build ──────────────────────────────────────────────────────

_setup_build() {
  _step "Build workspace image"

  if docker image inspect "$WORKSPACE_IMAGE" &>/dev/null 2>&1; then
    success "Workspace image already exists"
    _ask "Rebuild it?" || return 0
  else
    _ask "Build the workspace image now? (this may take a few minutes)" || {
      info "Skipping — run 'isopod build' when ready"
      return 0
    }
  fi

  require_docker
  build_all
}

# ── Step 6: Summary ──────────────────────────────────────────────────────────

_setup_summary() {
  header "Setup complete"

  echo "${BOLD}Next steps:${NC}"
  echo ""

  if [[ ${#ALL_REPO_DIRS[@]} -eq 0 ]]; then
    echo "  1. Clone your repos into repos/:"
    echo "     ${CYAN}git clone git@github.com:org/repo.git repos/repo${NC}"
    echo ""
    echo "  2. Customize your Docker environment:"
  else
    echo "  1. Customize your Docker environment (if needed):"
  fi

  echo "     ${DIM}docker.local/workspace.Dockerfile${NC}  — language runtimes, packages"
  echo "     ${DIM}docker.local/workspace-start.sh${NC}    — service startup, migrations"
  echo "     ${DIM}docker.local/docker-compose.template.yml${NC} — ports, env vars"
  echo ""

  if [[ ${#ALL_REPO_DIRS[@]} -gt 0 ]]; then
    local repos="${ALL_REPO_DIRS[*]}"
    echo "  2. Create your first pod:"
    echo "     ${CYAN}./isopod create my-feature ${repos// / }${NC}"
  else
    echo "  3. Create your first pod:"
    echo "     ${CYAN}./isopod create my-feature${NC}"
  fi
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────

cmd_setup() {
  header "isopod setup"
  echo "  This wizard will walk you through first-time setup."
  echo "  Already-configured steps will be detected and skipped."
  echo ""

  _setup_prerequisites
  _setup_docker_local
  _setup_ssh
  _setup_certs
  _setup_build
  _setup_summary
}
