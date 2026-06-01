# code-server

Each pod runs [code-server](https://github.com/coder/code-server) — VS Code in the browser. It gives every pod a full IDE without needing anything installed locally beyond a browser.

## Location

```
docker.local/code-server/
```

## Recommended architecture

Describe your long-running services **once** in `docker.local/services.json` (the
service manifest). On every `isopod up`, isopod regenerates everything downstream from
it, so port/log/command details can never drift between surfaces:

- **startup-terminals** — a named terminal per service that `tail -F`s its log
- **tasks.json** — start/stop/restart tasks per service
- **services-start.sh** — pre-creates every log, then starts each service
- **hooks/urls** — the URL list reads the manifest live

This separates concerns and removes drift:
- **services.json** — the single source of truth (the only file you edit)
- **workspace-start.sh** — generic; sources the generated `services-start.sh`
- **startup-terminals / tasks.json** — generated views of the manifest

See [services.json](#servicesjson) below. The remaining sections document the generated
artifacts and the extension internals.

### Why not start services from tasks?

code-server has a [known upstream VS Code bug](https://github.com/microsoft/vscode/issues/169376) where `runOn: folderOpen` tasks fire twice, creating duplicate terminals. `instanceLimit: 1` does not reliably prevent this. The startup-terminals extension uses the VS Code terminal API directly and checks `vscode.window.terminals` by name before creating, so duplicates are impossible.

## services.json

The service manifest at `docker.local/services.json` is the single source of truth for
a stack's long-running dev services:

```json
{
  "services": [
    { "id": "ide", "displayName": "IDE", "port": 8443, "protocol": "https",
      "urlLabel": "IDE", "tailInTerminal": false, "autoStart": false },
    { "id": "rails", "displayName": "Rails API", "port": 3000, "urlLabel": "API",
      "workdir": "/workspace/example-api", "logPath": "/tmp/rails.log",
      "startCommand": "rm -f tmp/pids/server.pid; bundle exec rails server -b 0.0.0.0 -p 3000" },
    { "id": "vite", "displayName": "Frontend", "port": 4000, "urlLabel": "Frontend",
      "workdir": "/workspace/example-frontend", "logPath": "/tmp/vite.log",
      "startCommand": "npx vite --host 0.0.0.0 --port 4000" }
  ]
}
```

Fields: `id`, `displayName`, `port`, `protocol` (`http`|`https`, default `http`),
`urlLabel` (emitted by `hooks/urls` when present), `workdir`, `logPath`, `startCommand`,
`stopPort` (defaults to `port`), `tailInTerminal` (default `true`), `autoStart`
(default `true`). A service with no `startCommand` is listed for its URL only (e.g. the
IDE). Stop/restart kill by port via `lsof -ti tcp:<port> | xargs -r kill -TERM`.

On every `isopod up`, isopod regenerates from this file (host-side, requires `jq`):
`code-server/settings.json` (the `startupTerminals.terminals` key), `code-server/tasks.json`,
and `services-start.sh`. Those files carry a "GENERATED — do not edit" marker; edit
`services.json` instead. Because they are bind-mounted, **changing a port or command
takes effect on the next pod start / window reload with no image rebuild**. A malformed
manifest fails `isopod up` loudly rather than silently doing nothing.

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

The `startupTerminals.terminals` key in `settings.json` is **generated** from
`services.json` — you don't hand-write it. Each service with a `logPath` (and
`tailInTerminal` not set to `false`) becomes a terminal that uses `tail -F` (note the
capital `-F`: it retries until the file exists and survives truncation, so the terminal
attaches immediately and never shows "tail: cannot open ..." while the service is still
starting):

```json
{
  "startupTerminals.terminals": [
    { "name": "Rails API", "command": "cd /workspace/example-api && tail -F /tmp/rails.log" },
    { "name": "Frontend", "command": "cd /workspace/example-frontend && tail -F /tmp/vite.log" }
  ]
}
```

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

### Service control tasks (manual, from command palette)

`tasks.json` is **generated** from `services.json`. Each service with a `startCommand`
gets `start` / `stop` / `restart` tasks runnable from `Cmd+Shift+P` → "Run Task". Stop
kills by port via `lsof`, so there's no brittle process-name matching:

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
      "presentation": { "reveal": "always", "panel": "dedicated", "group": "services" }
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

To change a command or port, edit `services.json` and re-run `isopod up` — do not edit
`tasks.json` directly.

## settings.json

General editor and IDE settings. Key settings:

```json
{
  "task.allowAutomaticTasks": "on",
  "terminal.integrated.enablePersistentSessions": false
}
```

- `task.allowAutomaticTasks` — without this, code-server prompts you to allow tasks every time you open a workspace
- `terminal.integrated.enablePersistentSessions` — prevents ghost terminals from being restored across sessions

## workspace-start.sh

`workspace-start.sh` no longer hard-codes service commands. It sources the generated
`services-start.sh`, pre-creates every log **before** code-server boots (so the startup
terminals' `tail -F` attach to existing files), and starts services after:

```bash
SERVICES_RUNNER=/usr/local/bin/services-start.sh
if [ -f "$SERVICES_RUNNER" ]; then
  source "$SERVICES_RUNNER"
  type precreate_logs &>/dev/null && precreate_logs   # before code-server
fi

# ... code-server launch ...

type start_services &>/dev/null && start_services      # after code-server
```

Keep one-time setup (db create/migrate, dependency installs) in `workspace-start.sh`;
the manifest is only for long-running services. Service logs live in `/tmp/` (cleared on
container restart, so no bloat) and `services-start.sh` is regenerated on every
`isopod up`.

## Multiple Rails servers

If you need multiple Rails environments (e.g. development + CI), add one manifest entry
per server with its own port, log, and PID file:

```json
{ "id": "rails-ci", "displayName": "Rails CI", "port": 3001, "urlLabel": "API CI",
  "workdir": "/workspace/api", "logPath": "/tmp/rails-ci.log",
  "startCommand": "RAILS_ENV=ci bundle exec rails server -b 0.0.0.0 -p 3001 -P tmp/pids/server-ci.pid" }
```

Without a distinct `-P` PID file, both servers write to the same PID file and the second
refuses to start.

## Tips

- Bind servers to `0.0.0.0` (not `localhost`) so they're accessible from outside the container
- Set a distinct `logPath` and `port` per service in `services.json`
- `jq` is required on the host (the generator uses it); `isopod setup` checks for it
