# Agent Checklist

Use this checklist before making non-trivial changes to isopod.

## Orientation

- Read `AGENTS.md`.
- Read `docs/architecture.md` for package boundaries and lifecycle context.
- Read `docs/development.md` for build/test commands.
- Read `docs/stack-templates.md` before touching stack, Docker, sharing, or
  pod-template behavior.
- Read `docs/offload.md` before touching the source-only Offload backend.
- Verify current code instead of trusting old shell-era notes.

## Git Safety

- Do not stage `stacks/**`.
- Run `git ls-files stacks`; it should print nothing.
- Treat `stacks/<stack>/repos/` and `stacks/<stack>/pods/` as user/project
  workspaces, not isopod source.
- Do not revert user changes unless explicitly asked.
- Avoid committing generated output.

## Implementation

- Prefer existing APIs exported from `api/src/index.ts`.
- Keep CLI command files thin; put behavior in `api`.
- Build `api` before `cli`.
- Preserve the public scaffold vs local stack boundary:
  - generic behavior belongs in `docker/`, `examples/`, `docs/`, or `api`.
  - private runtime config belongs under ignored `stacks/<stack>/...`.
- Use structured parsers or existing helpers for config where available.
- Keep changes scoped to the requested behavior.
- Keep `isopod offload` separate from the ordinary local pod commands and the
  dashboard.

## Verification

- For `api` changes, run:

```bash
cd api
npm test
```

- For CLI changes, build `api` and `cli`:

```bash
cd api && npm run build
cd ../cli && npm run build
```

- For UI changes, run:

```bash
cd ui
npm run build
```

- For sharing/template/compose changes, include a `git ls-files stacks` check in
  your final verification.

## Stack Commands

Use explicit `--stack <name>` for stack-scoped commands:

```bash
./isopod create <pod> <repos...> --stack <stack>
./isopod build --stack <stack>
./isopod up <pod>
./isopod recreate <pod>
./isopod remove <pod>
```

Some pod commands discover the stack from the pod name, but docs and scripts are
clearer when the stack is explicit where required.
