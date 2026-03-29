#!/bin/zsh
# lib/core.sh — Colors, helpers, and repo discovery

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# ── Helpers ────────────────────────────────────────────────────────────────────
info()    { echo "${BLUE}▸${NC} $1"; }
success() { echo "${GREEN}✓${NC} $1"; }
warn()    { echo "${YELLOW}⚠${NC} $1"; }
error()   { echo "${RED}✗${NC} $1" >&2; exit 1; }
header()  { printf "\n${BOLD}${CYAN}%s${NC}\n\n" "$1"; }

# ── Discover repos from repos/ directory ──────────────────────────────────────
ALL_REPO_DIRS=()
if [[ -d "$REPOS_DIR" ]]; then
  for _dir in "$REPOS_DIR"/*/; do
    [[ -d "$_dir" ]] || continue
    ALL_REPO_DIRS+=("$(basename "$_dir")")
  done
  unset _dir
fi

# Check if a repo name is valid
resolve_repo() {
  local input="$1"
  if [[ -d "$REPOS_DIR/$input" ]]; then
    echo "$input"
    return 0
  fi
  return 1
}

