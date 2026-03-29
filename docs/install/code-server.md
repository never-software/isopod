# code-server

Each pod runs [code-server](https://github.com/coder/code-server) — VS Code in the browser. It gives every pod a full IDE without needing anything installed locally beyond a browser.

## Location

```
docker.local/code-server/
```

## Recommended architecture

Start your application services (Rails, Vite, etc.) as background processes in `workspace-start.sh`, logging to files in `/tmp/`. Use the **startup-terminals** extension to automatically open named terminal tabs that tail those logs when you open the workspace. Use tasks.json for manual start/stop/restart from the command palette.

This separates concerns:
- **workspace-start.sh** — service lifecycle (always starts reliably with the container)
- **startup-terminals extension** — terminal visibility (opens log tails on workspace open)
- **tasks.json** — manual service control (start/stop/restart from command palette)

### Why not start services from tasks?

code-server has a [known upstream VS Code bug](https://github.com/microsoft/vscode/issues/169376) where `runOn: folderOpen` tasks fire twice, creating duplicate terminals. `instanceLimit: 1` does not reliably prevent this. The startup-terminals extension uses the VS Code terminal API directly and checks `vscode.window.terminals` by name before creating, so duplicates are impossible.

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

Add to `settings.json`:

```json
{
  "startupTerminals.terminals": [
    { "name": "Rails API", "command": "tail -f /tmp/rails.log" },
    { "name": "Frontend", "command": "tail -f /tmp/vite.log" }
  ],
  "startupTerminals.autoStart": true
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

Add start/stop/restart tasks so you can control services from `Cmd+Shift+P` → "Run Task":

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Rails (dev): restart",
      "type": "shell",
      "command": "pkill -f '[p]uma.*3000' 2>/dev/null; sleep 1; rm -f /workspace/api/tmp/pids/server.pid; cd /workspace/api && bundle exec rails server -b 0.0.0.0 -p 3000",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": {
        "reveal": "always",
        "panel": "dedicated",
        "group": "services",
        "showReuseMessage": false
      }
    },
    {
      "label": "Rails (dev): stop",
      "type": "shell",
      "command": "pkill -f '[p]uma.*3000' && echo 'Stopped' || echo 'Not running'",
      "problemMatcher": []
    }
  ]
}
```

The `[p]uma` bracket trick prevents `pkill` from matching its own process.

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

Start services as background processes with log files:

```bash
# Clean up stale PID files
rm -f /workspace/api/tmp/pids/server*.pid 2>/dev/null || true

# Start services with log output
cd /workspace/api
bundle exec rails server -b 0.0.0.0 -p 3000 &> /tmp/rails-dev.log &

cd /workspace/frontend
npm run dev -- --host 0.0.0.0 &> /tmp/frontend.log &

# Keep container alive
exec sleep infinity
```

The log files in `/tmp/` are what the startup-terminals extension tails. Services start immediately with the container and don't depend on opening the IDE.

## Multiple Rails servers

If you need multiple Rails environments (e.g. development + CI), use separate PID files:

```bash
cd /workspace/api
bundle exec rails server -b 0.0.0.0 -p 3000 &> /tmp/rails-dev.log &
RAILS_ENV=ci bundle exec rails server -b 0.0.0.0 -p 3001 -P /workspace/api/tmp/pids/server-ci.pid &> /tmp/rails-ci.log &
```

Without `-P`, both servers write to the same PID file and the second one refuses to start.

## Tips

- Bind servers to `0.0.0.0` (not `localhost`) so they're accessible from outside the container
- Clean up stale PID files in `workspace-start.sh` before starting services
- Service logs go to `/tmp/` which is cleared on container restart — no log file bloat
