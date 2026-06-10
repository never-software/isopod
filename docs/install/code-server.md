# code-server

Each pod runs [code-server](https://github.com/coder/code-server) — VS Code in the browser. It gives every pod a full IDE without needing anything installed locally beyond a browser.

## Location

```
docker.local/code-server/
```

## Recommended architecture

Describe your long-running services **once** in `docker.local/services.json` (the service manifest). On every `isopod up`, isopod regenerates everything downstream from it, so port/log/command details can never drift between surfaces:

- **startup-terminals** — a named terminal per service that `tail -F`s its log
- **tasks.json** — start/stop/restart tasks per service
- **services-start.sh** — pre-creates every log, then starts each service
- **hooks/urls** — the displayed URL list

This separates concerns and removes drift:
- **services.json** — the single source of truth (the only file you edit)
- **workspace-start.sh** — generic; sources the generated `services-start.sh`
- **startup-terminals / tasks.json / hooks/urls** — generated views of the manifest

See [services.json](#servicesjson) below. The remaining sections document the generated artifacts and the extension internals.

### Why not start services from tasks?

code-server has a [known upstream VS Code bug](https://github.com/microsoft/vscode/issues/169376) where `runOn: folderOpen` tasks fire twice, creating duplicate terminals. `instanceLimit: 1` does not reliably prevent this. The startup-terminals extension uses the VS Code terminal API directly and checks `vscode.window.terminals` by name before creating, so duplicates are impossible.

## services.json

The service manifest at `docker.local/services.json` is the single source of truth for a stack's long-running dev services:

```json
{
  "urlHost": "ip-${STACK}-${FEATURE_NAME}.orb.local",
  "services": [
    { "id": "ide", "displayName": "IDE", "port": 8443, "protocol": "https",
      "urlLabel": "IDE", "tailInTerminal": false, "autoStart": false },
    { "id": "rails", "displayName": "Rails API", "port": 3000, "urlLabel": "API",
      "workdir": "/workspace/example-api", "logPath": "/tmp/rails.log",
      "startCommand": "rm -f tmp/pids/server.pid; bundle exec rails server -b 0.0.0.0 -p 3000" },
    { "id": "vite", "displayName": "Frontend", "port": 4000, "urlLabel": "Frontend",
      "workdir": "/workspace/example-frontend", "logPath": "/tmp/vite.log",
      "startCommand": "VITE_API_URL=http://localhost:3000 npx vite --host 0.0.0.0 --port 4000" }
  ]
}
```

**Service fields:** `id`, `displayName`, `port`, `protocol` (`http`|`https`, default `http`), `urlLabel` (emits a URL line when set), `workdir`, `logPath`, `startCommand`, `stopPort` (defaults to `port`), `terminalCommand` (overrides the default `tail -F` — e.g. a REPL or `claude`), `tailInTerminal` (default `true`), `autoStart` (default `true`). A service with no `startCommand` is listed for its URL/terminal only (e.g. the IDE). Stop/restart kill by port: `lsof -ti tcp:<port> | xargs -r kill -TERM`, so the container needs `lsof`.

**Top-level `urlHost`** templates the URL host for `hooks/urls` (default `ip-${STACK}-${FEATURE_NAME}.orb.local` — the container name isopod assigns, which is the hostname OrbStack DNS resolves). `${STACK}` is substituted at generation time, since a docker.local dir belongs to exactly one stack; `${FEATURE_NAME}` stays a shell variable, expanded when the hook runs. Stacks with bespoke naming can still hard-code a host (orri uses `ip-orri-${FEATURE_NAME}.orb.local`).

On every `isopod up`, isopod regenerates (host-side, pure TypeScript in `api/src/services.ts` — **no jq or other host tooling**): `code-server/settings.json` (the `startupTerminals.terminals` key *only* — all your other settings are preserved), `code-server/tasks.json`, `services-start.sh`, and `hooks/urls`. Those files carry a "GENERATED — do not edit" marker; edit `services.json` instead. Because they're bind-mounted, **changing a port or command takes effect on the next pod start / window reload with no image rebuild**. A malformed manifest fails `isopod up` loudly rather than silently doing nothing.

**`autoStart: false`** lists a service in every view surface (terminal, tasks, URL, log pre-creation) but does *not* launch it from `services-start.sh`. Use it when a service needs bespoke launch orchestration in `workspace-start.sh` — dependency ordering, a non-root user, first-boot seeding — that a flat manifest can't express. The orri stack does exactly this: every service is `autoStart: false` and launched by orri's own entrypoint as the `dev` user, while the manifest still drives its terminals, tasks, and URLs.

## startup-terminals extension

A minimal VS Code extension that opens named terminals on workspace startup. It activates on `onStartupFinished` (fires exactly once per window lifecycle) and checks for existing terminals by name before creating new ones.

### Installation

The extension VSIX is at `docker.local/extensions/startup-terminals/`. Install it in your Dockerfile:

```dockerfile
COPY docker.local/extensions/startup-terminals/startup-terminals-1.0.0.vsix /tmp/startup-terminals.vsix
RUN code-server --install-extension /tmp/startup-terminals.vsix
```

Or install at runtime in `workspace-start.sh`:

```bash
if ! code-server --list-extensions 2>/dev/null | grep -qi "startup-terminals"; then
  code-server --install-extension /tmp/startup-terminals.vsix 2>/dev/null || true
fi
```

### Configuration

The `startupTerminals.terminals` key in `settings.json` is **generated** from `services.json` — you don't hand-write it. Each service with a `logPath` (and `tailInTerminal` not `false`) becomes a terminal that `cd`s into its `workdir` and runs `tail -F` (capital `-F` retries until the file exists and survives truncation, so the terminal attaches immediately and never shows "tail: cannot open ..." while the service is still starting):

```json
{
  "startupTerminals.terminals": [
    { "name": "Rails API", "command": "cd /workspace/example-api && tail -F /tmp/rails.log" },
    { "name": "Frontend", "command": "cd /workspace/example-frontend && tail -F /tmp/vite.log" }
  ]
}
```

A service can set `terminalCommand` (e.g. `"cd /workspace && claude"`) to open a non-tail terminal instead.

### Commands

Available from `Cmd+Shift+P`:

- **Startup Terminals: Open All** — create all configured terminals (skips any that already exist)
- **Startup Terminals: Kill All** — close all managed terminals
- **Startup Terminals: Restart All** — kill and recreate all terminals

### Building from source

```bash
cd docker.local/extensions/startup-terminals
npm install
npx -p typescript tsc -p ./
npx -p @vscode/vsce vsce package --no-dependencies
```

## tasks.json

### Service control tasks (generated, from command palette)

`tasks.json` is **generated** from `services.json`. Each service with a `startCommand` gets `start` / `stop` / `restart` tasks runnable from `Cmd+Shift+P` → "Run Task". Stop kills by port via `lsof`, so there's no brittle process-name matching:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Rails API: start",
      "type": "shell",
      "command": "cd /workspace/example-api && rm -f tmp/pids/server.pid; bundle exec rails server -b 0.0.0.0 -p 3000",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "reveal": "always", "panel": "dedicated", "group": "services", "showReuseMessage": false }
    },
    {
      "label": "Rails API: stop",
      "type": "shell",
      "command": "lsof -ti tcp:3000 | xargs -r kill -TERM",
      "problemMatcher": []
    }
  ]
}
```

To change a command or port, edit `services.json` and re-run `isopod up` — do not edit `tasks.json` directly.

## settings.json

General editor and IDE settings that you **hand-edit** — isopod only generates the
`startupTerminals.terminals` key (from [services.json](#servicesjson)) and preserves everything else
in this file. The keys below are optional recommendations, not generated output:

```json
{
  "task.allowAutomaticTasks": "on",
  "terminal.integrated.enablePersistentSessions": false
}
```

- `task.allowAutomaticTasks` — without this, code-server prompts you to allow tasks every time you open a workspace
- `terminal.integrated.enablePersistentSessions` — prevents ghost terminals from being restored across sessions

## workspace-start.sh

`workspace-start.sh` no longer hard-codes service commands. It sources the generated `services-start.sh`, pre-creates every log **before** code-server boots (so the startup terminals' `tail -F` attach to existing files), and starts services after:

```bash
SERVICES_RUNNER=/usr/local/bin/services-start.sh
if [ -f "$SERVICES_RUNNER" ]; then
  source "$SERVICES_RUNNER"
  type precreate_logs &>/dev/null && precreate_logs || true   # before code-server
fi

# ... code-server launch ...

if type start_services &>/dev/null; then
  start_services                                               # after code-server
fi
```

Keep one-time setup (database create/migrate, dependency installs) in `workspace-start.sh`; the manifest is only for long-running services. The generated `services-start.sh` defines two functions: `precreate_logs` (touch every log up front) and `start_services` (background-launch each `autoStart` service to its log).

## Multiple Rails servers

If you need multiple Rails environments (e.g. development + CI), add one manifest entry per server with its own port, log, and PID file:

```json
{ "id": "rails-ci", "displayName": "Rails CI", "port": 3001, "urlLabel": "API CI",
  "workdir": "/workspace/api", "logPath": "/tmp/rails-ci.log",
  "startCommand": "RAILS_ENV=ci bundle exec rails server -b 0.0.0.0 -p 3001 -P tmp/pids/server-ci.pid" }
```

Without a distinct `-P` PID file, both servers write to the same PID file and the second refuses to start.

## Tips

- Bind servers to `0.0.0.0` (not `localhost`) so they're accessible from outside the container
- Set a distinct `logPath` and `port` per service in `services.json`
- Service logs go to `/tmp/` which is cleared on container restart — no log file bloat
- The container needs `lsof` (the generated stop/restart tasks kill by port); orri's image already includes it
