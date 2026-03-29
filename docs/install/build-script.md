# build.sh

An optional build script that isopod uses instead of a plain `docker build` when it exists and is executable. Use it when your image requires build arguments, secrets, or custom build logic.

## Location

```
docker.local/build.sh
```

## When to use it

- Your Dockerfile needs **build arguments** (e.g., private registry tokens, API keys)
- You need to read secrets from `.env` files and pass them as build args
- You want to use **BuildKit features** like `--secret` or `--ssh`
- You need **multi-platform builds** or custom build flags

If you don't need any of this, you can skip this file — isopod falls back to a plain `docker build`.

## Environment variables

isopod sets these before calling your script:

| Variable | Description |
|----------|-------------|
| `DOCKER_DIR` | Path to the docker config directory |
| `PROJECT_ROOT` | Path to the isopod project root |
| `WORKSPACE_IMAGE` | Target image name (e.g., `isopod-workspace`) |
| `REPOS_DIR` | Path to the `repos/` directory |
| `GENERATED_DOCKERFILE` | Path to the generated Dockerfile (with cache-hook instructions injected) |

## Example

```bash
#!/bin/bash
set -euo pipefail

# Read tokens from a .env file
read_env_var() {
  local key="$1"
  grep -E "^${key}=" "$REPOS_DIR/my-app/.env" 2>/dev/null | head -1 | cut -d'=' -f2-
}

registry_token=$(read_env_var "REGISTRY_TOKEN")

# Build with the generated Dockerfile and build args
docker build \
  -f "${GENERATED_DOCKERFILE:-$DOCKER_DIR/workspace.Dockerfile}" \
  --build-arg "REGISTRY_TOKEN=$registry_token" \
  -t "$WORKSPACE_IMAGE" \
  "$PROJECT_ROOT" 2>&1
```

## Tips

- Always use `$GENERATED_DOCKERFILE` with a fallback to `$DOCKER_DIR/workspace.Dockerfile` — the generated file includes cache-hook instructions
- Use `set -euo pipefail` so build failures are loud
- Warn (don't error) on missing tokens — a build with limited access is better than no build at all
