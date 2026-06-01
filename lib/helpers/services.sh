#!/bin/zsh
# lib/helpers/services.sh — Generate per-pod service surfaces from services.json
#
# services.json (in $DOCKER_DIR) is the single source of truth for a stack's
# long-running dev services: port, log, workdir, start command, URL label.
#
# From it we GENERATE the surfaces that cannot read it at runtime:
#   - code-server/settings.json  (.["startupTerminals.terminals"] — tail -F + workdir)
#   - code-server/tasks.json     (start/stop/restart tasks per service)
#   - services-start.sh          (pre-create logs + start services; bind-mounted in)
#
# The shell surfaces read the manifest live instead (no generated artifact):
#   - hooks/urls                 (reads services.json on the host)
#   - workspace-start.sh         (sources the generated services-start.sh)
#
# Robust tailing: every log is pre-created (: > logPath) BEFORE code-server boots,
# and startup terminals use `tail -F` (retry + follow-name), so a terminal never
# shows "tail: cannot open ..." while its service is still starting.

# Path to the active stack's manifest.
services_manifest() {
  echo "$DOCKER_DIR/services.json"
}

# Regenerate every manifest-derived surface.
# Always (re)writes services-start.sh so the compose bind mount has a source,
# even for pods/stacks that predate services.json (stub functions in that case).
generate_services() {
  local manifest
  manifest=$(services_manifest)

  if [[ ! -f "$manifest" ]]; then
    _services_write_stub_runner
    return 0
  fi

  command -v jq &>/dev/null || \
    error "jq is required to generate service config from $manifest (install: brew install jq)"

  if ! jq empty "$manifest" 2>/dev/null; then
    error "Invalid JSON in $manifest — fix the manifest and re-run"
  fi

  _services_gen_settings "$manifest"
  _services_gen_tasks "$manifest"
  _services_gen_runner "$manifest"
}

# .["startupTerminals.terminals"] — one tail -F terminal per service with a log.
# Updates that single key in place, preserving all other code-server settings.
_services_gen_settings() {
  local manifest="$1"
  local dir="$DOCKER_DIR/code-server"
  local settings="$dir/settings.json"

  mkdir -p "$dir"
  [[ -f "$settings" ]] || echo '{}' > "$settings"

  local terminals
  terminals=$(jq '
    [ .services[]
      | select((.tailInTerminal != false) and (.logPath != null))
      | { name: .displayName,
          command: ((if .workdir then "cd " + .workdir + " && " else "" end)
                    + "tail -F " + .logPath) } ]' "$manifest")

  local tmp
  tmp=$(mktemp)
  jq --argjson t "$terminals" '.["startupTerminals.terminals"] = $t' "$settings" > "$tmp" \
    && mv "$tmp" "$settings" \
    || { rm -f "$tmp"; error "Failed to update $settings from manifest"; }
}

# tasks.json — start/stop/restart per service with a startCommand.
# Tasks run in their own dedicated terminal panel, so start is NOT redirected
# to the log (unlike the background runner). Stop kills by port via lsof.
_services_gen_tasks() {
  local manifest="$1"
  local dir="$DOCKER_DIR/code-server"
  local tasks="$dir/tasks.json"
  local tmp
  tmp=$(mktemp)

  mkdir -p "$dir"

  jq '
    def startcmd: (if .workdir then "cd " + .workdir + " && " else "" end) + .startCommand;
    def stopcmd: "lsof -ti tcp:" + ((.stopPort // .port) | tostring) + " | xargs -r kill -TERM";
    {
      version: "2.0.0",
      tasks: [ .services[]
        | select(.startCommand != null)
        | . as $s
        | ( [
              { label: ($s.displayName + ": start"), type: "shell",
                command: ($s | startcmd),
                isBackground: true, problemMatcher: [],
                presentation: { reveal: "always", panel: "dedicated", group: "services" } },
              { label: ($s.displayName + ": stop"), type: "shell",
                command: ($s | stopcmd), problemMatcher: [] },
              { label: ($s.displayName + ": restart"), type: "shell",
                command: (($s | stopcmd) + "; sleep 1; " + ($s | startcmd)),
                isBackground: true, problemMatcher: [],
                presentation: { reveal: "always", panel: "dedicated", group: "services" } }
            ] | .[] )
      ]
    }' "$manifest" > "$tmp" \
    || { rm -f "$tmp"; error "Failed to generate tasks.json from manifest"; }

  { echo "// GENERATED from services.json — do not edit; edit services.json and re-run isopod up"
    cat "$tmp"; } > "$tasks"
  rm -f "$tmp"
}

# services-start.sh — bash sourced by workspace-start.sh.
# precreate_logs(): touch every log up front (before code-server boots).
# start_services(): launch each autoStart service in the background to its log.
_services_gen_runner() {
  local manifest="$1"
  local runner="$DOCKER_DIR/services-start.sh"

  {
    echo "#!/bin/bash"
    echo "# GENERATED from services.json — do not edit; edit services.json and re-run isopod up."
    echo "# Sourced by workspace-start.sh; defines precreate_logs and start_services."
    echo ""
    echo "precreate_logs() {"
    jq -r '.services[] | select(.logPath != null) | "  : > " + (.logPath | @sh)' "$manifest"
    echo "  return 0"
    echo "}"
    echo ""
    echo "start_services() {"
    jq -r '.services[]
      | select(.startCommand != null and (.autoStart != false))
      | "  ( " + (if .workdir then "cd " + (.workdir | @sh) + " && " else "" end)
        + .startCommand + " ) &> " + ((.logPath // "/dev/null") | @sh) + " &"' "$manifest"
    echo "  return 0"
    echo "}"
  } > "$runner"
  chmod +x "$runner"
}

# No-manifest fallback: a runner whose hooks are no-ops, so the bind mount in
# docker-compose.template.yml always has a source file (never an empty dir).
_services_write_stub_runner() {
  local runner="$DOCKER_DIR/services-start.sh"
  [[ -d "$DOCKER_DIR" ]] || return 0
  {
    echo "#!/bin/bash"
    echo "# No services.json found — no managed services. (stub)"
    echo "precreate_logs() { return 0; }"
    echo "start_services() { return 0; }"
  } > "$runner"
  chmod +x "$runner"
}
