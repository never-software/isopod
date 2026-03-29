#!/bin/zsh
# lib/helpers/layers.sh — Layer registry and staleness detection
#
# Layers are parsed dynamically from `# layer: <name>` markers in the
# workspace Dockerfile. Nothing here is project-specific.

# ── Parse Layers from Dockerfile ───────────────────────────────────────────

_dockerfile_path() {
  echo "$DOCKER_DIR/workspace.Dockerfile"
}

# Populate LAYER_NAMES from Dockerfile markers
_layers_init() {
  LAYER_NAMES=()
  local dockerfile=$(_dockerfile_path)
  [[ -f "$dockerfile" ]] || return
  while IFS= read -r line; do
    if [[ "$line" =~ '^# layer: (.+)$' ]]; then
      LAYER_NAMES+=("${match[1]}")
    fi
  done < "$dockerfile"
}

# ── Version/Hash Detection ──────────────────────────────────────────────────

# Hash the Dockerfile content between this layer's marker and the next
_layer_current_version() {
  local layer="$1"
  local dockerfile=$(_dockerfile_path)
  [[ -f "$dockerfile" ]] || { echo "unknown"; return; }

  # Extract content from `# layer: <name>` to the next `# layer:` (or EOF)
  local content
  content=$(sed -n "/^# layer: ${layer}$/,/^# layer: /{ /^# layer: /!p; }" "$dockerfile")

  # If sed matched nothing (last layer), grab from marker to EOF
  if [[ -z "$content" ]]; then
    content=$(sed -n "/^# layer: ${layer}$/,\${ /^# layer: ${layer}$/!p; }" "$dockerfile")
  fi

  if [[ -n "$content" ]]; then
    echo "$content" | shasum -a 256 | cut -c1-12
  else
    echo "unknown"
  fi
}

# ── Stored Hashes ───────────────────────────────────────────────────────────

_layer_hash_dir() {
  echo "$DOCKER_DIR/.cache-hashes"
}

_layer_hash_file() {
  echo "$(_layer_hash_dir)/layer.$1"
}

_layer_stored_version() {
  local hash_file=$(_layer_hash_file "$1")
  if [[ -f "$hash_file" ]]; then
    cat "$hash_file"
  else
    echo ""
  fi
}

_layer_save_version() {
  local layer="$1"
  local version="$2"
  local hash_dir=$(_layer_hash_dir)
  mkdir -p "$hash_dir"
  echo -n "$version" > "$hash_dir/layer.$layer"
}

_layers_save_all() {
  for layer in "${LAYER_NAMES[@]}"; do
    local version=$(_layer_current_version "$layer")
    _layer_save_version "$layer" "$version"
  done
}

_layer_delete_version() {
  local hash_file=$(_layer_hash_file "$1")
  rm -f "$hash_file"
}

# ── Staleness ───────────────────────────────────────────────────────────────

_layer_status() {
  local layer="$1"
  local stored=$(_layer_stored_version "$layer")
  local current=$(_layer_current_version "$layer")

  if [[ -z "$stored" ]]; then
    echo "not built"
  elif [[ "$stored" == "$current" ]]; then
    echo "fresh"
  else
    echo "stale"
  fi
}

# ── Cascade ─────────────────────────────────────────────────────────────────

_layer_index() {
  local target="$1"
  local idx=1
  for layer in "${LAYER_NAMES[@]}"; do
    [[ "$layer" == "$target" ]] && { echo "$idx"; return 0; }
    idx=$((idx + 1))
  done
  return 1
}

_layers_from() {
  local target="$1"
  local found=false
  local result=()
  for layer in "${LAYER_NAMES[@]}"; do
    [[ "$layer" == "$target" ]] && found=true
    [[ "$found" == "true" ]] && result+=("$layer")
  done
  echo "${result[@]}"
}

_layers_after() {
  local target="$1"
  local found=false
  local result=()
  for layer in "${LAYER_NAMES[@]}"; do
    if [[ "$found" == "true" ]]; then
      result+=("$layer")
    fi
    [[ "$layer" == "$target" ]] && found=true
  done
  echo "${result[@]}"
}

_layer_exists() {
  local target="$1"
  for layer in "${LAYER_NAMES[@]}"; do
    [[ "$layer" == "$target" ]] && return 0
  done
  return 1
}

# ── Initialize on source ───────────────────────────────────────────────────
_layers_init
