# workspace-start.sh

The container entrypoint script. It runs every time a container starts and is responsible for booting services, installing dependencies, and keeping the container alive.

## Location

```
docker.local/workspace-start.sh
```

## What to put in it

- **Start backing services** — PostgreSQL, Redis, or any infrastructure your app needs
- **Install/sync dependencies** — `bundle install`, `npm ci`, etc. for the repos active in this pod
- **Run database migrations** — apply pending migrations on boot
- **First-boot setup** — seed databases on initial creation, skip on subsequent boots
- **Start code-server** — launch the browser-based IDE
- **Start application services** — Rails servers, Vite dev servers, etc. as background processes with log output
- **Keep alive** — end with `exec sleep infinity` so the container stays running

## How it works

The script runs inside the container as the entrypoint (`CMD` in the Dockerfile). isopod sets the `ISOPOD_REPOS` environment variable with a comma-separated list of repos active in the pod. Use this to clean up unused repos from the image.

Application services should be started here (not in code-server tasks) for reliability. Log output to files in `/tmp/` so code-server tasks can `tail -f` them for visibility. See the [code-server docs](code-server.md) for how to set up the log tailing tasks.

## Example

```bash
#!/bin/bash
set -e

# Remove repos not active in this pod
if [ -n "$ISOPOD_REPOS" ]; then
  IFS=',' read -ra active_repos <<< "$ISOPOD_REPOS"
  for dir in /workspace/*/; do
    [ -d "$dir" ] || continue
    dir_name=$(basename "$dir")
    match=false
    for repo in "${active_repos[@]}"; do
      [ "$repo" = "$dir_name" ] && match=true && break
    done
    [ "$match" = false ] && rm -rf "$dir"
  done
fi

# Start PostgreSQL
echo "Starting PostgreSQL..."
su postgres -c "pg_ctl start -D /pgdata -l /tmp/postgres.log -w"

# Start Redis
echo "Starting Redis..."
redis-server --daemonize yes --bind 127.0.0.1

# Install dependencies
if [ -f /workspace/my-app/Gemfile ]; then
  cd /workspace/my-app && bundle install
fi

# First boot: seed databases
if [ ! -f /pgdata/.databases_ready ]; then
  cd /workspace/my-app
  bundle exec rails db:create db:migrate db:seed
  touch /pgdata/.databases_ready
else
  # Subsequent boots: run pending migrations
  cd /workspace/my-app && bundle exec rails db:migrate
fi

# Start code-server
code-server --bind-addr 0.0.0.0:8443 --auth none /workspace &> /tmp/code-server.log &

# Clean up stale PID files
rm -f /workspace/my-app/tmp/pids/server*.pid 2>/dev/null || true

# Start application services (logs tailed by code-server tasks)
cd /workspace/my-app
bundle exec rails server -b 0.0.0.0 -p 3000 &> /tmp/rails.log &

cd /workspace/my-frontend
npm run dev -- --host 0.0.0.0 &> /tmp/frontend.log &

# Keep container alive
exec sleep infinity
```

## Tips

- Use a flag file (like `.databases_ready`) to distinguish first boot from restarts
- Start backing services (PostgreSQL, Redis) before running migrations — they need to be available
- Start application services as background processes with `&> /tmp/service.log &`
- Clean up stale PID files before starting Rails servers — leftover PIDs from a previous container stop will prevent startup
- Log service output to `/tmp/` so code-server tasks can `tail -f` them and the logs are cleared on container restart
- Always end with `exec sleep infinity` — without it the container exits immediately
- For multiple Rails servers on different ports, use `-P` to specify separate PID files
