# Development

This repo is a TypeScript monorepo without a root package manager workspace.
Install, build, and test packages from their own directories.

## Prerequisites

- macOS
- OrbStack for Docker runtime and `.orb.local` DNS
- Node.js compatible with the package you are working in
- `clang` for `api` postinstall, which compiles `api/bin/clone`

## Install and Build

Build order matters because `cli` imports the compiled `api` package.

```bash
cd api
npm install
npm run build

cd ../cli
npm install
npm run build

cd ../ui
npm install
npm run build
```

For iterative development:

```bash
cd api && npm run dev
cd ui && npm run dev
```

Run the CLI from the repo root after building `api` and `cli`:

```bash
./isopod <command>
```

The Nix flake packages only the TypeScript API and CLI plus immutable Offload
assets for `x86_64-linux`; it deliberately does not build `ui/` or the
dashboard bundle. Package installation compiles the native clone helper and
fails if that compilation fails; unsupported silent success is not allowed.

## Tests

The main automated test suite is in `api`.

```bash
cd api
npm test
```

Focused examples:

```bash
cd api
node --test dist/sharing.test.js
node --test --test-name-pattern="<name>" dist/sharing.test.js
```

Run the relevant focused tests for small changes. Run the full `api` suite when
touching shared behavior such as pod lifecycle, compose generation, sharing,
Docker/cache, DB snapshots, or indexer config.

## Stack-Scoped Commands

Several commands require `--stack <name>`. Do not rely on old stack-less
examples.

Common stack-scoped commands:

```bash
./isopod create <pod> <repos...> --stack <stack>
./isopod build --stack <stack>
./isopod fresh-db-seed --stack <stack>
./isopod search <query> --stack <stack>
./isopod cache list --stack <stack>
./isopod sharing workspace list --stack <stack>
```

Some pod-name commands can discover the stack from an existing pod name, but
being explicit is safer in scripts and docs.

## Offload Commands

The Offload backend is separate from the ordinary local commands and is meant to
run on the Offload host through the external lock wrapper:

```bash
isopod offload create <stack> <pod> --repo <name>=<remote-url> --ref <name>=refs/heads/<branch> --json
isopod offload up <stack> <pod> --json
isopod offload exec <stack> <pod> --json -- <command...>
isopod offload status [<stack> <pod>] --json
isopod offload lease <stack> <pod> --json
isopod offload stop <stack> <pod> --json
isopod offload remove <stack> <pod> --json
```

Mutating Offload operations require `ISOPOD_OFFLOAD_LOCK_HELD=1`, set only by
the wrapper that owns the single host `flock`. Offload stores mutable state
under `ISOPOD_STATE_ROOT` and immutable assets under `ISOPOD_ASSET_ROOT`; when
those roots are set, checkout `.env` files are not loaded. See
`docs/offload.md` for the full source-only contract.

## Docker Context

isopod follows the active Docker context and does not pass `--context`. If
Docker Desktop changes the active context, OrbStack DNS and `.orb.local` pod
URLs may fail.

Check and fix with:

```bash
docker context show
docker context use orbstack
```

## Local State

Do not stage local stack state:

```bash
git ls-files stacks
```

That command should print nothing. If it prints tracked paths, remove them from
the index without deleting the local files:

```bash
git rm --cached -r stacks
```

The `.gitignore` entry `/stacks/` is intentional. Stack instances contain local
repos, pods, auth state, generated compose files, and project-specific runtime
config.

## Common Paths

```text
api/src/pods.ts                 pod lifecycle
api/src/compose.ts              compose generation
api/src/docker.ts               image build and cache-bust injection
api/src/sharing.ts              workspace/home sharing manifests
api/src/workspace-template.ts   copy-missing workspace templates
api/src/services.ts             generated code-server/service surfaces
api/src/indexer/                live semantic indexer
cli/src/commands/               CLI command wrappers
ui/src/                         dashboard frontend
docker/                         public generic stack scaffold
examples/                       public example setup
```

## Stale or Generated Things

- Root `dist/` is not part of the current package layout.
- `api/dist/`, `cli/dist/`, and `indexer/dist/dashboard/` are build outputs.
- `indexer/src/` is not the live indexer source.
- Private stack templates may contain tool-specific files, but those are local
  stack state unless deliberately promoted to `docker/`, `examples/`, or docs.
