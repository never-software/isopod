#!/bin/zsh
# commands/build.sh — Rebuild the workspace image (without reseeding databases)

cmd_build() {
  require_docker
  build_all

  success "Image rebuilt. Existing pods will pick up new deps on next 'isopod up'."
}
