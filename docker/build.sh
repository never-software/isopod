#!/bin/bash
# build.sh — Build the workspace Docker image
#
# Optional: only needed if your build requires custom logic (private
# registries, build args, multi-stage builds). If this file doesn't exist
# or isn't executable, isopod falls back to a plain `docker build`.
#
# Environment variables set by isopod:
#   DOCKER_DIR              — Path to this directory (docker/)
#   PROJECT_ROOT            — Path to the project root
#   WORKSPACE_IMAGE         — Target image name (e.g., isopod-workspace)
#   REPOS_DIR               — Path to the repos/ directory
#   GENERATED_DOCKERFILE    — Path to the generated Dockerfile (with cache-hook instructions)

set -euo pipefail

# Example: read a token from a repo's .env for private package registries
# token=$(grep "^MY_TOKEN=" "$REPOS_DIR/myapp/.env" 2>/dev/null | cut -d'=' -f2-)

docker build \
  -f "${GENERATED_DOCKERFILE:-$DOCKER_DIR/workspace.Dockerfile}" \
  -t "$WORKSPACE_IMAGE" \
  "$PROJECT_ROOT" 2>&1

# To pass build args:
# docker build \
#   -f "${GENERATED_DOCKERFILE:-$DOCKER_DIR/workspace.Dockerfile}" \
#   --build-arg "MY_TOKEN=$token" \
#   -t "$WORKSPACE_IMAGE" \
#   "$PROJECT_ROOT" 2>&1
