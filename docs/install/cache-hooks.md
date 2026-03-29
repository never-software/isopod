# Cache hooks

Scripts that generate Dockerfile instructions at build time to pre-install dependencies. Each hook handles one technology (gems, node modules, etc.) per repo. Docker's layer caching ensures only repos with changed lockfiles trigger a reinstall — everything else is a cache hit.

## Location

```
docker.local/cache-hooks/
```

## How it works

When you run `isopod build`, the orchestrator `all.sh` iterates over every repo in `repos/` and runs each sibling hook against it. Each hook checks if it's relevant (e.g., `gems.sh` skips repos without a Gemfile) and outputs Dockerfile `COPY` + `RUN` instructions.

The combined output is injected into your [`workspace.Dockerfile`](workspace-dockerfile.md) at the `__CACHE_HOOK_INSTRUCTIONS__` placeholder.

For example, with two repos:

```dockerfile
COPY repos/my-rails-app/Gemfile repos/my-rails-app/Gemfile.lock /workspace/my-rails-app/
RUN cd /workspace/my-rails-app && bundle install
COPY repos/my-react-app/package.json repos/my-react-app/pnpm-lock.yaml /workspace/my-react-app/
RUN cd /workspace/my-react-app && pnpm install --frozen-lockfile
```

Change `my-rails-app`'s Gemfile? Only that repo's gems layer rebuilds. Everything else is a cache hit.

## `all.sh` (required)

The orchestrator. Iterates repos, runs each sibling hook, collects output. Each hook receives:

| Variable | Description |
|----------|-------------|
| `REPO_DIR` | Path to the repo |
| `REPO_NAME` | Repo directory name |
| `DOCKER_DIR` | Path to the docker config directory |
| `WORKSPACE_IMAGE` | Docker image name |

## Example: `gems.sh`

Handles Ruby dependencies. Skips repos without a Gemfile. Includes `.ruby-version` in the cache key so a Ruby upgrade invalidates the layer.

```bash
#!/bin/bash
set -euo pipefail

[[ -f "$REPO_DIR/Gemfile" ]] || exit 0

copy_files="repos/${REPO_NAME}/Gemfile repos/${REPO_NAME}/Gemfile.lock"
[[ -f "$REPO_DIR/.ruby-version" ]] && copy_files="$copy_files repos/${REPO_NAME}/.ruby-version"

echo "COPY $copy_files /workspace/${REPO_NAME}/"
echo "RUN cd /workspace/${REPO_NAME} && bundle install"
```

## Example: `node.sh`

Handles Node.js dependencies. Detects the package manager from the lockfile present.

```bash
#!/bin/bash
set -euo pipefail

[[ -f "$REPO_DIR/package.json" ]] || exit 0

copy_files="repos/${REPO_NAME}/package.json"

if [[ -f "$REPO_DIR/pnpm-lock.yaml" ]]; then
  copy_files="$copy_files repos/${REPO_NAME}/pnpm-lock.yaml"
  install_cmd="pnpm install --frozen-lockfile"
elif [[ -f "$REPO_DIR/yarn.lock" ]]; then
  copy_files="$copy_files repos/${REPO_NAME}/yarn.lock"
  install_cmd="yarn install --frozen-lockfile"
elif [[ -f "$REPO_DIR/package-lock.json" ]]; then
  copy_files="$copy_files repos/${REPO_NAME}/package-lock.json"
  install_cmd="npm ci"
else
  install_cmd="npm install"
fi

[[ -f "$REPO_DIR/.nvmrc" ]] && copy_files="$copy_files repos/${REPO_NAME}/.nvmrc"
[[ -f "$REPO_DIR/.node-version" ]] && copy_files="$copy_files repos/${REPO_NAME}/.node-version"

echo "COPY $copy_files /workspace/${REPO_NAME}/"
echo "RUN cd /workspace/${REPO_NAME} && $install_cmd"
```

## Example: `seeds.sh`

Cache hooks can also handle non-Dockerfile concerns. A seeds hook can detect when database seed files have changed or when the month has rolled over (for time-sensitive seed data), destroy the stale base volume, and warn the user to reseed. These hooks output warnings to stderr rather than Dockerfile instructions to stdout.

## Writing cache hooks

- Exit with `exit 0` if the hook doesn't apply to this repo
- Output valid Dockerfile instructions to stdout — `COPY` and `RUN` lines
- Use `$REPO_NAME` in paths, never hardcode repo names
- Include version files (`.ruby-version`, `.nvmrc`) in `COPY` instructions so runtime upgrades bust the cache
- For non-Dockerfile concerns (like seed staleness), output warnings to stderr instead
