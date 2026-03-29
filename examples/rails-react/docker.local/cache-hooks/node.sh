#!/bin/bash
# cache-hooks/node.sh — Emit Dockerfile instructions for Node.js dependencies
#
# If the repo has a package.json, outputs COPY + RUN instructions to install
# node modules. Detects the package manager from the lockfile present.
#
# Environment variables (set by all.sh):
#   REPO_DIR         — Path to the repo (e.g., /path/to/repos/example-frontend)
#   REPO_NAME        — Repo directory name (e.g., example-frontend)

set -euo pipefail

[[ -f "$REPO_DIR/package.json" ]] || exit 0

copy_files="repos/${REPO_NAME}/package.json"
install_cmd=""

if [[ -f "$REPO_DIR/pnpm-lock.yaml" ]]; then
  copy_files="$copy_files repos/${REPO_NAME}/pnpm-lock.yaml"
  install_cmd="pnpm install --frozen-lockfile"
elif [[ -f "$REPO_DIR/yarn.lock" ]]; then
  copy_files="$copy_files repos/${REPO_NAME}/yarn.lock"
  install_cmd="yarn install --frozen-lockfile"
elif [[ -f "$REPO_DIR/package-lock.json" ]]; then
  copy_files="$copy_files repos/${REPO_NAME}/package-lock.json"
  install_cmd="npm ci"
else
  install_cmd="npm install"
fi

echo "COPY $copy_files /workspace/${REPO_NAME}/"
echo "RUN cd /workspace/${REPO_NAME} && $install_cmd"
