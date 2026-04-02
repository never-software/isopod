#!/bin/zsh
# lib/search.sh — Search indexed code

INDEXER="$PROJECT_ROOT/indexer/dist/cli.js"

cmd_search() {
  if [[ ! -f "$INDEXER" ]]; then
    error "Indexer not built. Run: cd indexer && npm install && npm run build"
  fi

  [[ -z "$1" ]] && error "Usage: isopod search <query> [--pod <name>] [--repo <name>] [-n <limit>]"

  node "$INDEXER" search "$@"
}
