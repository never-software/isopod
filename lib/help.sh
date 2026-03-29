#!/bin/zsh
# commands/help.sh — Show help and usage information

cmd_help() {
  echo ""
  echo "${BOLD}isopod${NC} — Manage parallel workspaces for multi-agent development"
  echo ""
  echo "${BOLD}Commands:${NC}"
  echo "  ${BOLD}create${NC}        <feature-name> [repos...] [--from <branch>]"
  echo "  ${BOLD}up${NC}            <feature-name>                Start or refresh container (uses cache)"
  echo "  ${BOLD}down${NC}          <feature-name>                Stop container (preserves data)"
  echo "  ${BOLD}exec${NC}          <feature-name> <cmd>          Run a command inside the container"
  echo "  ${BOLD}enter${NC}         <feature-name>                Open a shell inside the container"
  echo "  ${BOLD}build${NC}                                       Rebuild workspace image"
  echo "  ${BOLD}fresh-db-seed${NC}                               Build image and seed base database"
  echo "  ${BOLD}db${NC}            save|restore|list|delete      Manage database snapshots"
  echo "  ${BOLD}cache${NC}         list|rebuild|delete|destroy  Manage build cache layers"
  echo "  ${BOLD}status${NC}        [feature-name]                Show container health"
  echo "  ${BOLD}list${NC}                                        List active pods"
  echo "  ${BOLD}info${NC}                                        Show pods, volumes, and cache"
  echo "  ${BOLD}nuke${NC}                                        Remove all containers, volumes, and cache"
  echo "  ${BOLD}remove${NC}        <feature-name>                Remove a pod"
  echo "  ${BOLD}help${NC}                                        Show this help"
  echo ""

  if [[ ${#ALL_REPO_DIRS[@]} -gt 0 ]]; then
    echo "${BOLD}Repos:${NC}"
    for _name in "${ALL_REPO_DIRS[@]}"; do
      echo "  $_name"
    done
    echo "  all                      All repos"
    echo ""
  fi

  echo "${BOLD}Exec options:${NC}"
  echo "  --dir, -C <path>       Set working directory inside container"
  echo ""
  echo "${BOLD}Create options:${NC}"
  echo "  --from <branch>        Start pod from a specific branch"
  echo ""
  echo "${BOLD}Examples:${NC}"
  echo "  isopod create my-feature"
  echo "  isopod create my-feature all"
  echo "  isopod up my-feature"
  echo "  isopod exec my-feature ls /workspace"
  echo "  isopod status"
  echo "  isopod remove my-feature"
  echo ""
}
