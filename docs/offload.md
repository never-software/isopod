# Offload Backend

The Offload backend is a separate CLI-only backend for running source-only pods
on a server that owns its own rootless Docker daemon. It does not replace the
ordinary macOS/OrbStack pod lifecycle, and it is not used by the dashboard.

Use the ordinary commands for local pods:

```bash
./isopod create <pod> <repos...> --stack <stack>
./isopod up <pod>
./isopod remove <pod>
```

Use the Offload subgroup only on the Offload host, through the external wrapper
that owns the single host lock:

```bash
isopod offload create <stack> <pod> \
  --repo api=git@example.test:org/api.git \
  --ref api=refs/heads/main \
  --json

isopod offload up <stack> <pod> --json
isopod offload exec <stack> <pod> --json -- git status --short
isopod offload status [<stack> <pod>] --json
isopod offload lease <stack> <pod> --json
isopod offload stop <stack> <pod> --json
isopod offload remove <stack> <pod> --json
```

The option shape is deliberately `name=value` so SSH remotes containing `@` stay
unambiguous. Refs must be explicit remote branch refs such as
`refs/heads/main`.

## Source Boundary

Offload creation is Git-only on the Offload host:

- each requested remote ref is resolved with `git ls-remote`;
- exactly one matching ref is required;
- the resolved commit is recorded in metadata;
- the repo is fetched and checked out at that exact commit;
- a real upstream is configured for later safety checks.

Offload never copies from a local pod, never copies checkout `.env` files, never
copies home/session/SSH-agent state, never transfers database volumes, and never
starts app services. The workspace container stays quiet until an explicit
`offload exec` command runs something inside it.

`offload up` refuses partial or failed initial clones. Fix the remote ref, remove
the failed pod explicitly, and recreate it; an incomplete working copy is never
promoted into a running workspace.

Remote URLs containing embedded credentials, query parameters, or fragments are
rejected. SSH usernames are allowed, with authentication provided by the
Offload host environment outside isopod metadata.

## Roots

Offload splits immutable assets from mutable state:

```text
ISOPOD_ASSET_ROOT  immutable package assets, usually in the Nix store
ISOPOD_STATE_ROOT  mutable Offload state, usually /var/lib/isopod-offload
```

When those variables are absent, existing local defaults remain checkout-based,
including legacy `ISOPOD_ROOT` behavior. When either Offload root is set,
checkout `.env` files are not auto-loaded.

Mutable Offload state lives below `ISOPOD_STATE_ROOT`: repositories, metadata,
generated Compose files, secret-file references, temporary files, and future
lock files. Immutable Offload assets live below `ISOPOD_ASSET_ROOT`: the
source-only Dockerfile and the offline-loadable Nix-built base image archive.

## JSON Contract

Every public Offload command supports `--json`. The schema is versioned:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "operation": "status",
  "result": {}
}
```

`status` also reports any running managed container whose metadata is missing as
an `orphanedContainers` entry. Lease and pressure automation fails loudly on
that inconsistency; `stop-all` remains label-derived so safe disable can still
stop the container without deleting state.
Managed containers with missing labels or a container name that does not match
their deterministic stack/pod identity are rejected instead of being omitted
from admission or pressure accounting.

`doctor` returns the full check list plus an aggregate `healthy` boolean. It
exits non-zero when any check fails, including in JSON mode, so automation cannot
mistake a completed diagnostic for a healthy lane.

The diagnostic includes the same admission headroom used by new workloads:
host free space, state-image usage, and the memory remaining after a standard
3 GiB reservation. These checks make the runtime gates visible before an
operator attempts `create` or `up`; they do not replace the Control module's
separate 160 GiB preflight for first-time image creation.

Errors are also machine-readable and fail closed:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "operation": "create",
  "error": {
    "code": "offload_lock_required",
    "message": "Mutating Offload operations must run under the external flock wrapper"
  }
}
```

## Locking

Mutating operations require the future Control wrapper or timer to hold the
single external host lock and set:

```bash
ISOPOD_OFFLOAD_LOCK_HELD=1
```

The lock gate applies to `create`, `up`, `exec`, `lease`, `stop`, `remove`, and
the hidden timer operations. `status` and `doctor` are read-only and do not
require the lock. isopod intentionally does not implement a second in-process
lock.

The Control wrapper passes its open lock descriptor in
`ISOPOD_OFFLOAD_LOCK_FD`. `exec` renews the lease and metadata while that lock is
held, closes only the inherited descriptor, and then runs the potentially long
container command. That keeps lifecycle writes serialized without preventing
the lease or pressure timers from stopping a long-running workload.

## Compose And Resources

Offload Compose is generated from immutable assets and is rootless-safe. It has
no `ipc: host`, host port publication, `env_file`, Docker socket mount,
SSH-agent bind, package-token path, or persistent environment dump.

The source-only profile sets:

- two CPUs;
- 3 GiB memory reservation;
- 6 GiB hard memory limit;
- 6 GiB memory-plus-swap limit, so no swap is available beyond the memory cap;
- `shm_size: 4gb`;
- 4096 PIDs;
- two-minute stop grace.

Compose labels mark managed Offload images, containers, volumes, and networks
with the stack, pod, and profile. Repository working copies are bind-mounted
from `ISOPOD_STATE_ROOT`; the home directory uses a per-pod named volume.

The package includes an offline-loadable base image archive built by Nix. Before
Compose starts, isopod runs an idempotent `docker load` from that archive, then
builds the per-pod image locally from the immutable source-only Dockerfile. The
Dockerfile uses the local base tag and does not pull from a registry.

## Secrets

The only secret seam is file-based and future-scoped:

```text
ISOPOD_STATE_ROOT/secrets/openai-base-url
ISOPOD_STATE_ROOT/secrets/openai-api-key
```

Compose references those files as Docker/BuildKit secrets and exposes only
`OPENAI_BASE_URL_FILE` and `OPENAI_API_KEY_FILE` inside the container. Secret
values are never written to metadata, labels, build args, Compose environment
values, or generated `.env` files.

## Leases And Pressure

`create` creates a six-hour lease. `up`, `exec`, and `lease` renew it. Lease
expiry gracefully stops the container with the normal two-minute grace and keeps
repositories and volumes.

Admission runs before new `create` or `up` work:

- fail if the host filesystem has less than 50 GiB free;
- fail if the state filesystem exceeds 90% use;
- fail if the 3 GiB reservation would leave under 12 GiB `MemAvailable`;
- fail if six managed Offload pods are already running.

Pressure handling is a hidden timer operation. If `MemAvailable` is below 8 GiB
for two consecutive checks, it gracefully stops the least-recently-renewed
running Offload pod, continuing in lease order until at least 12 GiB is
available or no managed Offload pods remain. It never deletes repositories or
volumes, and it resets the low-pressure counter once pressure clears.

The hidden `stop-all` operation gracefully stops every running managed Offload
container in deterministic stack/pod order. It is intended for the later Control
disable path before rootless Docker stops or its image is unmounted.

## Removal

Normal `offload remove` is intentionally conservative. Every repo must be clean,
have an upstream, and have local `HEAD` reachable from a freshly resolved
recorded remote ref. If any repo is dirty, lacks an upstream, or has unpushed
work, removal fails.

Force removal requires both flags:

```bash
isopod offload remove <stack> <pod> --force --confirm <stack>/<pod> --json
```

There is no Offload equivalent of `nuke`. `stop`, lease expiry, pressure
handling, and `stop-all` never delete repositories or volumes.
