#!/bin/bash
# cache-hooks/gems.sh — Emit Dockerfile instructions for Ruby dependencies
#
# If the repo has a Gemfile, outputs COPY + RUN instructions to install gems.
#
# Environment variables (set by all.sh):
#   REPO_DIR         — Path to the repo (e.g., /path/to/repos/example-api)
#   REPO_NAME        — Repo directory name (e.g., example-api)

set -euo pipefail

[[ -f "$REPO_DIR/Gemfile" ]] || exit 0

copy_files="repos/${REPO_NAME}/Gemfile repos/${REPO_NAME}/Gemfile.lock"
[[ -f "$REPO_DIR/.ruby-version" ]] && copy_files="$copy_files repos/${REPO_NAME}/.ruby-version"

echo "COPY $copy_files /workspace/${REPO_NAME}/"
echo "RUN cd /workspace/${REPO_NAME} && bundle install"
