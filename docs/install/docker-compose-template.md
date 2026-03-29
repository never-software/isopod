# docker-compose.template.yml

The Compose template that isopod uses to generate a per-pod `docker-compose.yml`. It contains placeholders that get replaced at pod creation time.

## Location

```
docker.local/docker-compose.template.yml
```

## Placeholders

isopod replaces these at generation time:

| Placeholder | Replaced with |
|-------------|---------------|
| `__FEATURE_NAME__` | Pod name (e.g., `my-feature`) |
| `__DOCKER_DIR__` | Absolute path to the docker config directory |
| `__IMAGE_NAME__` | Workspace image name (e.g., `isopod-workspace`) |
| `__REPO_LIST__` | Comma-separated list of active repos |
| `__REPO_VOLUMES__` | Bind-mount volume definitions for each repo |

`__REPO_VOLUMES__` is auto-generated based on which repos are included in the pod. For each repo, isopod creates:
- A bind mount from the pod directory into `/workspace/<repo>`
- Anonymous volumes for `tmp/`, `log/`, and `node_modules/` (if applicable) to avoid syncing build artifacts

## Example

```yaml
services:
  workspace:
    image: __IMAGE_NAME__
    container_name: __FEATURE_NAME__
    hostname: __FEATURE_NAME__
    init: true
    environment:
      - NODE_ENV=development
      - ISOPOD_REPOS=__REPO_LIST__
      - PGUSER=postgres
      - REDIS_URL=redis://localhost:6379/0
    ports:
      - "3000"    # Rails
      - "5173"    # Vite
      - "8443"    # code-server
    volumes:
__REPO_VOLUMES__
      - pgdata:/pgdata

volumes:
  pgdata:
```

## Tips

- Use port ranges without host bindings (just `"3000"`) — Docker assigns random host ports, avoiding conflicts between pods
- Add a named volume for database data (`pgdata`) so it persists across container restarts
- Set `init: true` so zombie processes get cleaned up
- Add environment variables your app needs — they apply to every pod
