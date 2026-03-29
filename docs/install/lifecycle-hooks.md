# Lifecycle hooks

Executable scripts that run at specific points in a pod's lifecycle. They let you wire up project-specific logic — cloning database volumes, installing dependencies, checking service health — without modifying isopod itself.

## Location

```
docker.local/hooks/
```

Each hook must be executable (`chmod +x`).

## Hook reference

### `pre-create`

Runs **before** the container starts for a new pod. Use it for host-side preparation like cloning a base database volume so the container boots with a seeded database.

```bash
# Environment variables:
#   COMPOSE_PROJECT   — Docker Compose project name (e.g., isopod-my-feature)
#   WORKSPACE_IMAGE   — Docker image name
#   POD_DIR           — Path to the pod directory
#   FEATURE_NAME      — Feature name
```

**Example** — clone a cached database volume for the new pod:

```bash
#!/bin/bash
set -euo pipefail

BASE_VOL="isopod-base-pgdata"
PROJECT_VOL="${COMPOSE_PROJECT}_pgdata"

if docker volume inspect "$BASE_VOL" >/dev/null 2>&1; then
  echo "▸ Cloning base database..."
  docker volume create "$PROJECT_VOL" >/dev/null
  docker run --rm \
    -v "$BASE_VOL":/from:ro \
    -v "$PROJECT_VOL":/to \
    alpine sh -c "cp -a /from/. /to/"
  echo "✓ Database cloned"
fi
```

### `post-up`

Runs **every time** a container starts (both `create` and `up`). Use it for host-side setup that needs to happen on every boot.

```bash
# Environment variables:
#   CONTAINER         — Container name
#   POD_DIR           — Path to the pod directory
#   FEATURE_NAME      — Feature name
#   COMPOSE_FILE      — Path to docker-compose.yml
#   COMPOSE_PROJECT   — Docker Compose project name
```

### `post-create`

Runs **once** after a new pod's container is fully up. Use it for one-time setup like running database migrations or verifying service health.

```bash
# Environment variables:
#   CONTAINER         — Container name
#   POD_DIR           — Path to the pod directory
#   FEATURE_NAME      — Feature name
```

### `post-workspace`

Runs after workspace setup completes (called at the end of `up`).

```bash
# Environment variables:
#   POD_DIR           — Path to the pod directory
#   FEATURE_NAME      — Feature name
```

### `teardown-workspace`

Runs when a pod is being removed. Use it to clean up external resources.

```bash
# Environment variables:
#   FEATURE_NAME      — Feature name
```

## Writing hooks

- Use `set -euo pipefail` so failures are loud
- Use the provided environment variables rather than hardcoding paths
- Keep hooks idempotent — `post-up` runs on every restart, not just the first time
- Service startup (Postgres, Redis) belongs in [`workspace-start.sh`](workspace-start.md), not hooks — hooks run on the host, the entrypoint runs inside the container
