#!/bin/zsh
# lib/index.sh — Manage code indexing

INDEXER="$PROJECT_ROOT/indexer/dist/cli.js"

cmd_index() {
  if [[ ! -f "$INDEXER" ]]; then
    error "Indexer not built. Run: cd indexer && npm install && npm run build"
  fi

  local subcmd="${1:-status}"
  case "$subcmd" in
    status)
      node "$INDEXER" status
      ;;
    base)
      shift
      node "$INDEXER" index-base "$@"
      ;;
    pod)
      shift
      local pod_name="$1"
      [[ -z "$pod_name" ]] && error "Usage: isopod index pod <name>"
      node "$INDEXER" index-pod "$pod_name"
      ;;
    daemon)
      shift
      local action="${1:-status}"
      node "$INDEXER" daemon "$action"
      ;;
    *)
      error "Usage: isopod index [status|base [repo]|pod <name>|daemon start|stop|status]"
      ;;
  esac
}
