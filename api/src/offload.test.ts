import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createOffloadPod,
  doctorOffload,
  execOffloadPod,
  expireOffloadLeases,
  generateOffloadCompose,
  handleOffloadPressure,
  offloadJsonError,
  offloadPaths,
  offloadRoots,
  parseNameValueOption,
  parseRepoRefOptions,
  removeOffloadPod,
  renewOffloadLease,
  statusOffloadPods,
  stopAllOffloadPods,
  stopOffloadPod,
  upOffloadPod,
  type CommandResult,
  type CommandOptions,
  type OffloadError,
  type OffloadPodMetadata,
  type OffloadRuntimeDeps,
} from "./offload.js";
import {
  resolveAssetRoot,
  resolveStateRoot,
  shouldLoadLocalEnv,
} from "./config.js";

const GIB = 1024 ** 3;
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

function ok(stdout = ""): CommandResult {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "failed"): CommandResult {
  return { status: 1, stdout: "", stderr };
}

function tempRoots() {
  const root = mkdtempSync(join(tmpdir(), "isopod-offload-test-"));
  const assetRoot = join(root, "assets");
  const stateRoot = join(root, "state");
  mkdirSync(join(assetRoot, "docker", "offload"), { recursive: true });
  mkdirSync(join(assetRoot, "images"), { recursive: true });
  writeFileSync(join(assetRoot, "docker", "offload", "workspace.Dockerfile"), "FROM isopod-offload-source-only:1\n");
  writeFileSync(join(assetRoot, "images", "isopod-offload-source-only.tar"), "not-a-real-tar-for-unit-tests");
  writeFileSync(join(assetRoot, "images", "isopod-offload-source-only.name"), "isopod-offload-source-only:1\n");
  return {
    root,
    assetRoot,
    stateRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeDeps(opts: {
  assetRoot: string;
  stateRoot: string;
  lock?: boolean;
  now?: Date;
  lsRemote?: string;
  dockerRunning?: Array<{ name: string; stack: string; pod: string; profile?: string }>;
  memAvailable?: number | number[];
  gitOverride?: OffloadRuntimeDeps["runGit"];
}): OffloadRuntimeDeps & {
  gitCalls: Array<{ args: string[]; cwd?: string }>;
  dockerCalls: Array<string[]>;
  dockerCallOptions: CommandOptions[];
  dockerRunning: Array<{ name: string; stack: string; pod: string; profile?: string }>;
} {
  const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
  const dockerCalls: Array<string[]> = [];
  const dockerCallOptions: CommandOptions[] = [];
  const dockerRunning = [...(opts.dockerRunning ?? [])];
  const memValues = Array.isArray(opts.memAvailable) ? [...opts.memAvailable] : undefined;
  const singleMemValue = Array.isArray(opts.memAvailable) ? undefined : opts.memAvailable;
  const env: NodeJS.ProcessEnv = {
    ISOPOD_ASSET_ROOT: opts.assetRoot,
    ISOPOD_STATE_ROOT: opts.stateRoot,
    ...(opts.lock === false ? {} : { ISOPOD_OFFLOAD_LOCK_HELD: "1" }),
  };

  const deps: OffloadRuntimeDeps & {
    gitCalls: Array<{ args: string[]; cwd?: string }>;
    dockerCalls: Array<string[]>;
    dockerCallOptions: CommandOptions[];
    dockerRunning: Array<{ name: string; stack: string; pod: string; profile?: string }>;
  } = {
    env,
    now: () => opts.now ?? new Date("2026-08-24T10:00:00.000Z"),
    statFilesystem: () => ({
      totalBytes: 100 * GIB,
      freeBytes: 80 * GIB,
      usedBytes: 20 * GIB,
    }),
    memAvailableBytes: () => {
      if (memValues) return memValues.shift() ?? memValues[memValues.length - 1] ?? 32 * GIB;
      return singleMemValue ?? 32 * GIB;
    },
    runGit: (args, runOpts = {}) => {
      gitCalls.push({ args, cwd: runOpts.cwd });
      if (opts.gitOverride) return opts.gitOverride(args, runOpts);
      if (args[0] === "ls-remote") return ok(opts.lsRemote ?? `${COMMIT_A}\t${args[3]}\n`);
      if (args[0] === "rev-parse" && args[1]?.startsWith("refs/remotes/origin/")) return ok(`${COMMIT_A}\n`);
      if (args[0] === "rev-parse" && args.includes("@{u}")) return ok("origin/main\n");
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return ok("true\n");
      if (args[0] === "status") return ok("");
      if (args[0] === "merge-base") return ok("");
      return ok("");
    },
    runDocker: (args, runOpts = {}) => {
      dockerCalls.push(args);
      dockerCallOptions.push(runOpts);
      if (args[0] === "ps") {
        return ok(dockerRunning
          .map((container) => `${container.name}\t${container.stack}\t${container.pod}\t${container.profile ?? "source-only"}`)
          .join("\n"));
      }
      if (args[0] === "stop") {
        const name = args[3];
        const index = dockerRunning.findIndex((container) => container.name === name);
        if (index >= 0) dockerRunning.splice(index, 1);
        return ok("");
      }
      return ok("");
    },
    gitCalls,
    dockerCalls,
    dockerCallOptions,
    dockerRunning,
  };
  return deps;
}

function readMeta(stack: string, pod: string, deps: OffloadRuntimeDeps): OffloadPodMetadata {
  return JSON.parse(readFileSync(offloadPaths(stack, pod, deps).metadataFile, "utf-8")) as OffloadPodMetadata;
}

async function createOnePod(stack: string, pod: string, deps: OffloadRuntimeDeps): Promise<OffloadPodMetadata> {
  return createOffloadPod(stack, pod, [
    { name: "api", remoteUrl: "ssh://git@example.test/org/api.git", requestedRef: "refs/heads/main" },
  ], deps);
}

test("asset and state roots split only in Offload mode; local defaults stay checkout/root based", () => {
  const roots = tempRoots();
  try {
    const localAssetRoot = resolveAssetRoot({ ISOPOD_ROOT: roots.root });
    const localStateRoot = resolveStateRoot({ ISOPOD_ROOT: roots.root });
    assert.equal(localAssetRoot, localStateRoot);
    assert.equal(shouldLoadLocalEnv({ ISOPOD_ROOT: roots.root }), true);

    const env = { ISOPOD_ASSET_ROOT: roots.assetRoot, ISOPOD_STATE_ROOT: roots.stateRoot };
    assert.equal(resolveAssetRoot(env), roots.assetRoot);
    assert.equal(resolveStateRoot(env), roots.stateRoot);
    assert.equal(shouldLoadLocalEnv(env), false);

    const resolved = offloadRoots({ env });
    assert.equal(resolved.assetRoot, roots.assetRoot);
    assert.equal(resolved.stateRoot, roots.stateRoot);
    assert.equal(resolved.autoLoadsLocalEnv, false);
  } finally {
    roots.cleanup();
  }
});

test("create resolves an exact remote ref, records the commit, and checks out that identity", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });
    const metadata = await createOnePod("demo", "pod-a", deps);

    assert.equal(metadata.repositories[0].resolvedCommit, COMMIT_A);
    assert.ok(deps.gitCalls.some((call) => call.args[0] === "ls-remote" && call.args[3] === "refs/heads/main"));
    assert.ok(deps.gitCalls.some((call) => call.args.join(" ") === `checkout -B main ${COMMIT_A}`));
    assert.ok(deps.gitCalls.some((call) => call.args.join(" ") === "branch --set-upstream-to origin/main main"));
    assert.equal(metadata.status, "running");
  } finally {
    roots.cleanup();
  }
});

test("missing and ambiguous remote refs fail closed and leave failed metadata when state was created", async () => {
  const missing = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: missing.assetRoot, stateRoot: missing.stateRoot, lsRemote: "" });
    await assert.rejects(
      () => createOnePod("demo", "missing-ref", deps),
      (err) => (err as OffloadError).code === "remote_ref_missing",
    );
    assert.equal(readMeta("demo", "missing-ref", deps).status, "failed");
    const dockerCallsBeforeUp = deps.dockerCalls.length;
    await assert.rejects(
      () => upOffloadPod("demo", "missing-ref", deps),
      (err) => (err as OffloadError).code === "pod_source_incomplete",
    );
    assert.equal(deps.dockerCalls.length, dockerCallsBeforeUp);
    assert.throws(
      () => renewOffloadLease("demo", "missing-ref", deps),
      (err: unknown) => (err as OffloadError).code === "pod_source_incomplete",
    );
    assert.throws(
      () => execOffloadPod("demo", "missing-ref", ["true"], {}, deps),
      (err: unknown) => (err as OffloadError).code === "pod_source_incomplete",
    );
    assert.equal(stopOffloadPod("demo", "missing-ref", deps).status, "failed");
    assert.equal(readMeta("demo", "missing-ref", deps).status, "failed");
    assert.equal(removeOffloadPod("demo", "missing-ref", {
      force: true,
      confirm: "demo/missing-ref",
    }, deps).removed, true);
    assert.equal(existsSync(offloadPaths("demo", "missing-ref", deps).podRoot), false);
  } finally {
    missing.cleanup();
  }

  const ambiguous = tempRoots();
  try {
    const deps = makeDeps({
      assetRoot: ambiguous.assetRoot,
      stateRoot: ambiguous.stateRoot,
      lsRemote: `${COMMIT_A}\trefs/heads/main\n${COMMIT_B}\trefs/heads/main\n`,
    });
    await assert.rejects(
      () => createOnePod("demo", "ambiguous-ref", deps),
      (err) => (err as OffloadError).code === "remote_ref_ambiguous",
    );
    assert.equal(readMeta("demo", "ambiguous-ref", deps).status, "failed");
  } finally {
    ambiguous.cleanup();
  }
});

test("source-only bootstrap creates no local runtime, data, session, or env persistence paths", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });
    const metadata = await createOnePod("demo", "source-only", deps);
    const paths = offloadPaths("demo", "source-only", deps);
    const compose = readFileSync(paths.composeFile, "utf-8");

    assert.ok(existsSync(join(paths.reposRoot, "api")));
    assert.ok(!existsSync(join(paths.podRoot, ".pod_env")));
    assert.ok(!existsSync(join(paths.podRoot, "home")));
    assert.ok(!compose.includes("env_file"));
    assert.ok(!compose.includes("docker.sock"));
    assert.ok(!compose.includes("SSH_AUTH_SOCK"));
    assert.ok(!compose.includes(".claude"));
    assert.ok(!compose.includes("prod-backup"));
    assert.equal(metadata.roots.assetRoot, roots.assetRoot);
    assert.equal(metadata.roots.stateRoot, roots.stateRoot);
  } finally {
    roots.cleanup();
  }
});

test("generated Compose is rootless-safe, labeled, resource capped, and offline-base backed", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });
    const metadata = await createOnePod("demo", "compose-safe", deps);
    const paths = offloadPaths("demo", "compose-safe", deps);
    const compose = generateOffloadCompose(metadata, paths);

    assert.ok(compose.includes("pull_policy: never"));
    assert.ok(compose.includes("shm_size: 4gb"));
    assert.ok(compose.includes("stop_grace_period: 2m"));
    assert.ok(compose.includes("cpus: 2"));
    assert.ok(compose.includes("mem_reservation: 3g"));
    assert.ok(compose.includes("memory: 3g"));
    assert.ok(compose.includes("mem_limit: 6g"));
    assert.ok(compose.includes("memswap_limit: 6g"));
    assert.ok(compose.includes("pids_limit: 4096"));
    assert.ok(compose.includes("pids: 4096"));
    assert.ok(compose.includes("isopod.managed: \"true\""));
    assert.ok(compose.includes("isopod.backend: \"offload\""));
    assert.ok(compose.includes(`name: ${JSON.stringify(metadata.resources.volumeName)}`));
    assert.ok(compose.includes(`name: ${JSON.stringify(metadata.resources.networkName)}`));
    assert.ok(!compose.includes("ipc: host"));
    assert.ok(!compose.includes("ports:"));
    assert.ok(deps.dockerCalls.some((args) => args[0] === "load" && args[1] === "-i"));
    assert.ok(deps.dockerCalls.some((args) =>
      args.includes("up")
      && args.includes("--build")
      && args.includes("--wait")
      && args.includes("--wait-timeout")
    ));
  } finally {
    roots.cleanup();
  }
});

test("accepted identities map to Docker Compose-safe, collision-free resource names", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });
    const dotted = await createOnePod("work.space", "orri-main", deps);
    const punctuated = await createOnePod("work-space", "orri_main", deps);

    for (const value of [
      ...Object.values(dotted.resources),
      ...Object.values(punctuated.resources),
    ]) {
      if (value === dotted.resources.composeFile || value === punctuated.resources.composeFile) continue;
      assert.match(value, /^[a-z0-9][a-z0-9_-]*(?::[a-z0-9_-]+)?$/);
    }
    assert.notEqual(dotted.resources.composeProject, punctuated.resources.composeProject);
  } finally {
    roots.cleanup();
  }
});

test("immutable Offload image assets must agree on the fixed local base identity", async () => {
  const roots = tempRoots();
  try {
    writeFileSync(join(roots.assetRoot, "images", "isopod-offload-source-only.name"), "wrong-image:latest\n");
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });

    await assert.rejects(
      () => createOnePod("demo", "asset-drift", deps),
      (err) => (err as OffloadError).code === "offload_assets_invalid",
    );
    assert.equal(deps.dockerCalls.some((args) => args[0] === "load"), false);
    const doctor = doctorOffload(deps);
    assert.equal(doctor.healthy, false);
    const imageNameCheck = doctor.checks.find((check) => check.name === "base-image-name");
    assert.equal(imageNameCheck?.ok, false);
  } finally {
    roots.cleanup();
  }
});

test("doctor reports the exact disk and memory admission headroom", () => {
  const roots = tempRoots();
  try {
    mkdirSync(roots.stateRoot, { recursive: true });
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });
    const healthy = doctorOffload(deps);

    for (const name of [
      "host-filesystem-headroom",
      "state-filesystem-headroom",
      "memory-admission-headroom",
    ]) {
      assert.equal(healthy.checks.find((check) => check.name === name)?.ok, true);
    }

    deps.statFilesystem = (path) => path === "/"
      ? { totalBytes: 100 * GIB, freeBytes: 40 * GIB, usedBytes: 60 * GIB }
      : { totalBytes: 100 * GIB, freeBytes: 5 * GIB, usedBytes: 95 * GIB };
    deps.memAvailableBytes = () => 14 * GIB;
    const constrained = doctorOffload(deps);

    assert.equal(constrained.healthy, false);
    assert.equal(constrained.checks.find((check) => check.name === "host-filesystem-headroom")?.ok, false);
    assert.equal(constrained.checks.find((check) => check.name === "state-filesystem-headroom")?.ok, false);
    assert.equal(constrained.checks.find((check) => check.name === "memory-admission-headroom")?.ok, false);
  } finally {
    roots.cleanup();
  }
});

test("secret values are never persisted in Compose, labels, build args, or env dumps", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });
    deps.env = {
      ...deps.env,
      OPENAI_API_KEY: "sk-secret-value",
      ANTHROPIC_API_KEY: "claude-secret-value",
      NPM_TOKEN: "npm-secret-value",
    };
    await createOnePod("demo", "secret-free", deps);
    const compose = readFileSync(offloadPaths("demo", "secret-free", deps).composeFile, "utf-8");

    assert.ok(compose.includes("OPENAI_BASE_URL_FILE: /run/secrets/openai_base_url"));
    assert.ok(compose.includes("OPENAI_API_KEY_FILE: /run/secrets/openai_api_key"));
    assert.ok(compose.includes("HOME: /home/dev"));
    assert.ok(compose.includes("file:"));
    assert.ok(!compose.includes("sk-secret-value"));
    assert.ok(!compose.includes("claude-secret-value"));
    assert.ok(!compose.includes("npm-secret-value"));
    assert.ok(!compose.includes("NPM_TOKEN"));
    assert.ok(!compose.includes("build_args"));
    assert.ok(!compose.includes("args:"));
  } finally {
    roots.cleanup();
  }
});

test("JSON helpers and CLI option parsing keep a stable schema and SSH-safe name=value split", () => {
  const parsed = parseNameValueOption("api=ssh://git@example.test/org/repo.git?x=a=b", "--repo");
  assert.equal(parsed.name, "api");
  assert.equal(parsed.value, "ssh://git@example.test/org/repo.git?x=a=b");

  assert.deepEqual(parseRepoRefOptions(
    ["api=git@example.test:org/api.git"],
    ["api=refs/heads/main"],
  ), [{
    name: "api",
    remoteUrl: "git@example.test:org/api.git",
    requestedRef: "refs/heads/main",
  }]);

  const body = offloadJsonError("create", new Error("plain failure"));
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.ok, false);
  assert.equal(body.operation, "create");
  assert.equal(body.error.code, "unexpected_error");

  assert.throws(
    () => statusOffloadPods({ stack: "demo" }, { env: { ISOPOD_STATE_ROOT: "/tmp/isopod-state" } }),
    (err: unknown) => (err as OffloadError).code === "status_scope_invalid",
  );
});

test("source creation rejects missing, duplicate, local, helper, credential-bearing, and option-like remotes before writing state", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });

    await assert.rejects(
      () => createOffloadPod("demo", "no-repos", [], deps),
      (err) => (err as OffloadError).code === "repo_required",
    );
    await assert.rejects(
      () => createOffloadPod("demo", "duplicate-repos", [
        { name: "api", remoteUrl: "git@example.test:org/api.git", requestedRef: "refs/heads/main" },
        { name: "api", remoteUrl: "git@example.test:org/other.git", requestedRef: "refs/heads/main" },
      ], deps),
      (err) => (err as OffloadError).code === "duplicate_repo",
    );

    const rejected = [
      "/tmp/local-repo",
      "file:///tmp/local-repo",
      "ext::sh -c unsafe",
      "https://token@example.test/org/repo.git",
      "https://example.test/org/repo.git?token=secret",
      "ssh://git@example.test/org/repo.git?token=secret",
      "git://user:token@example.test/org/repo.git",
      "git@example.test:org/repo.git?token=secret",
      "git@example.test:org/repo.git#secret",
      "--upload-pack=unsafe",
    ];

    for (const [index, remoteUrl] of rejected.entries()) {
      const pod = `bad-remote-${index}`;
      await assert.rejects(
        () => createOffloadPod("demo", pod, [{
          name: "api",
          remoteUrl,
          requestedRef: "refs/heads/main",
        }], deps),
        (err) => ["invalid_remote_url", "remote_transport_unsupported", "credential_remote_rejected"]
          .includes((err as OffloadError).code),
      );
      assert.equal(existsSync(offloadPaths("demo", pod, deps).podRoot), false);
    }
    assert.equal(deps.gitCalls.length, 0);
  } finally {
    roots.cleanup();
  }
});

test("lease renews for six hours and expiry stops without deleting repos or volumes", async () => {
  const roots = tempRoots();
  try {
    let now = new Date("2026-08-24T10:00:00.000Z");
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot, now });
    const metadata = await createOnePod("demo", "lease-test", deps);
    deps.dockerRunning.push({ name: metadata.resources.containerName, stack: "demo", pod: "lease-test" });

    now = new Date("2026-08-24T11:00:00.000Z");
    deps.now = () => now;
    const renewed = renewOffloadLease("demo", "lease-test", deps);
    assert.equal(renewed.leaseRenewedAt, "2026-08-24T11:00:00.000Z");
    assert.equal(renewed.leaseExpiresAt, "2026-08-24T17:00:00.000Z");

    now = new Date("2026-08-24T17:00:01.000Z");
    const expired = expireOffloadLeases(deps);
    assert.deepEqual(expired.expired.map((pod) => pod.pod), ["lease-test"]);
    const stopCall = deps.dockerCalls.findIndex(
      (args) => args.join(" ") === `stop --time 120 ${metadata.resources.containerName}`,
    );
    assert.notEqual(stopCall, -1);
    assert.ok((deps.dockerCallOptions[stopCall].timeoutMs ?? 0) > 120_000);
    assert.ok(existsSync(join(offloadPaths("demo", "lease-test", deps).reposRoot, "api")));
    const expiredMetadata = readMeta("demo", "lease-test", deps);
    assert.equal(expiredMetadata.status, "stopped");
    assert.equal(expiredMetadata.lastOperatorActivityAt, "2026-08-24T11:00:00.000Z");
  } finally {
    roots.cleanup();
  }
});

test("up and exec renew leases, while a failed up records failed rather than running", async () => {
  const roots = tempRoots();
  try {
    let now = new Date("2026-08-24T10:00:00.000Z");
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot, now });
    await createOnePod("demo", "restart", deps);

    now = new Date("2026-08-24T11:00:00.000Z");
    deps.now = () => now;
    const up = await upOffloadPod("demo", "restart", deps);
    assert.equal(up.leaseExpiresAt, "2026-08-24T17:00:00.000Z");

    now = new Date("2026-08-24T12:00:00.000Z");
    const executed = execOffloadPod("demo", "restart", ["git", "status"], {}, deps);
    assert.equal(executed.metadata.leaseExpiresAt, "2026-08-24T18:00:00.000Z");

    const failingDeps: OffloadRuntimeDeps = {
      ...deps,
      runDocker: (args, opts) => {
        if (args[0] === "compose") return fail("compose failed");
        return deps.runDocker!(args, opts);
      },
    };
    await assert.rejects(
      () => upOffloadPod("demo", "restart", failingDeps),
      (err) => (err as OffloadError).code === "docker_up_failed",
    );
    const failedMetadata = readMeta("demo", "restart", deps);
    assert.equal(failedMetadata.status, "failed");
    assert.equal(failedMetadata.failure?.code, "docker_up_failed");
  } finally {
    roots.cleanup();
  }
});

test("exec releases its inherited lifecycle-lock descriptor before running a long command", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });
    await createOnePod("demo", "long-exec", deps);
    const lockFd = openSync(join(roots.stateRoot, "lifecycle.lock"), "w");
    deps.env!.ISOPOD_OFFLOAD_LOCK_FD = String(lockFd);
    const originalDocker = deps.runDocker!;
    deps.runDocker = (args, opts) => {
      if (args[0] === "exec") {
        assert.throws(
          () => fstatSync(lockFd),
          (err: unknown) => (err as NodeJS.ErrnoException).code === "EBADF",
        );
      }
      return originalDocker(args, opts);
    };

    const result = execOffloadPod("demo", "long-exec", ["sh", "-lc", "sleep 1"], {}, deps);
    assert.equal(result.exitCode, 0);
  } finally {
    roots.cleanup();
  }
});

test("pressure handling waits for two low checks and stops least-recently-renewed pods first", async () => {
  const roots = tempRoots();
  try {
    let now = new Date("2026-08-24T10:00:00.000Z");
    const deps = makeDeps({
      assetRoot: roots.assetRoot,
      stateRoot: roots.stateRoot,
      now,
    });
    const older = await createOnePod("demo", "older", deps);
    deps.dockerRunning.push({ name: older.resources.containerName, stack: "demo", pod: "older" });
    now = new Date("2026-08-24T11:00:00.000Z");
    deps.now = () => now;
    const newer = await createOnePod("demo", "newer", deps);
    deps.dockerRunning.push({ name: newer.resources.containerName, stack: "demo", pod: "newer" });
    const pressureMem = [7 * GIB, 7 * GIB, 13 * GIB];
    deps.memAvailableBytes = () => pressureMem.shift() ?? 13 * GIB;

    const first = handleOffloadPressure(deps);
    assert.equal(first.lowCount, 1);
    assert.deepEqual(first.stopped, []);

    const second = handleOffloadPressure(deps);
    assert.equal(second.lowCount, 0);
    assert.deepEqual(second.stopped.map((pod) => pod.pod), ["older"]);
    assert.equal(readMeta("demo", "older", deps).status, "stopped");
    assert.equal(readMeta("demo", "newer", deps).status, "running");
  } finally {
    roots.cleanup();
  }
});

test("admission rejects the seventh running Offload pod using Docker labels", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });
    for (let i = 0; i < 6; i += 1) {
      const metadata = await createOnePod("demo", `running-${i}`, deps);
      deps.dockerRunning.push({
        name: metadata.resources.containerName,
        stack: metadata.stack,
        pod: metadata.pod,
      });
    }
    const gitCallsBeforeRejection = deps.gitCalls.length;
    await assert.rejects(
      () => createOnePod("demo", "seventh", deps),
      (err) => (err as OffloadError).code === "offload_capacity_exceeded",
    );
    assert.equal(deps.gitCalls.length, gitCallsBeforeRejection);
    assert.equal(existsSync(offloadPaths("demo", "seventh", deps).podRoot), false);
  } finally {
    roots.cleanup();
  }
});

test("corrupt metadata and pressure state fail loudly instead of hiding timer state", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });
    await createOnePod("demo", "corrupt", deps);
    writeFileSync(offloadPaths("demo", "corrupt", deps).metadataFile, "{not-json\n");
    assert.throws(
      () => statusOffloadPods({}, deps),
      (err: unknown) => (err as OffloadError).code === "metadata_invalid",
    );

    const pressurePath = offloadPaths("pressure", "probe", deps).pressureFile;
    mkdirSync(join(roots.stateRoot), { recursive: true });
    writeFileSync(pressurePath, "{not-json\n");
    deps.memAvailableBytes = () => 7 * GIB;
    assert.throws(
      () => handleOffloadPressure(deps),
      (err: unknown) => (err as OffloadError).code === "pressure_state_invalid",
    );

    const profileRoots = tempRoots();
    try {
      const profileDeps = makeDeps({ assetRoot: profileRoots.assetRoot, stateRoot: profileRoots.stateRoot });
      await createOnePod("demo", "tampered-profile", profileDeps);
      const profilePaths = offloadPaths("demo", "tampered-profile", profileDeps);
      const metadata = readMeta("demo", "tampered-profile", profileDeps);
      metadata.profile.memoryLimitBytes = 99 * GIB;
      writeFileSync(profilePaths.metadataFile, `${JSON.stringify(metadata)}\n`);
      await assert.rejects(
        () => upOffloadPod("demo", "tampered-profile", profileDeps),
        (err) => (err as OffloadError).code === "metadata_invalid",
      );
    } finally {
      profileRoots.cleanup();
    }
  } finally {
    roots.cleanup();
  }
});

test("status exposes orphaned managed containers and pressure handling refuses to ignore them", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });
    const metadata = await createOnePod("demo", "orphan", deps);
    deps.dockerRunning.push({ name: metadata.resources.containerName, stack: "demo", pod: "orphan" });
    rmSync(offloadPaths("demo", "orphan", deps).metadataFile);
    deps.memAvailableBytes = () => 7 * GIB;
    const status = statusOffloadPods({}, deps);
    assert.deepEqual(status.orphanedContainers.map((container) => container.name), [
      metadata.resources.containerName,
    ]);
    assert.equal(handleOffloadPressure(deps).lowCount, 1);
    assert.throws(
      () => handleOffloadPressure(deps),
      (err: unknown) => (err as OffloadError).code === "running_container_metadata_missing",
    );
  } finally {
    roots.cleanup();
  }
});

test("managed Docker inventory fails closed on missing or inconsistent identity labels", () => {
  const roots = tempRoots();
  try {
    for (const dockerRunning of [
      [{ name: "managed-without-stack", stack: "", pod: "orphan" }],
      [{ name: "wrong-deterministic-name", stack: "demo", pod: "orphan" }],
    ]) {
      const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot, dockerRunning });
      assert.throws(
        () => statusOffloadPods({}, deps),
        (err: unknown) => (err as OffloadError).code === "managed_container_identity_invalid",
      );
    }
  } finally {
    roots.cleanup();
  }
});

test("mutating Offload operations require external flock proof before doing work", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot, lock: false });
    await assert.rejects(
      () => createOnePod("demo", "no-lock", deps),
      (err) => (err as OffloadError).code === "offload_lock_required",
    );
    assert.equal(deps.gitCalls.length, 0);
    assert.equal(deps.dockerCalls.length, 0);

    const explicitRootDeps: OffloadRuntimeDeps = {
      ...deps,
      env: { ISOPOD_OFFLOAD_LOCK_HELD: "1" },
    };
    await assert.rejects(
      () => createOnePod("demo", "no-explicit-roots", explicitRootDeps),
      (err) => (err as OffloadError).code === "offload_roots_required",
    );
  } finally {
    roots.cleanup();
  }
});

test("remove refuses dirty, missing-upstream, and unpushed repos; force needs exact confirmation", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });
    await createOnePod("demo", "remove-dirty", deps);
    assert.throws(
      () => removeOffloadPod("demo", "remove-dirty", {}, {
        ...deps,
        runGit: (args, opts) => {
          if (args[0] === "status") return ok(" M app.rb\n");
          return deps.runGit!(args, opts);
        },
      }),
      (err: unknown) => (err as OffloadError).code === "remove_dirty_repo",
    );

    await createOnePod("demo", "remove-upstream", deps);
    assert.throws(
      () => removeOffloadPod("demo", "remove-upstream", {}, {
        ...deps,
        runGit: (args, opts) => {
          if (args[0] === "rev-parse" && args.includes("@{u}")) return fail("no upstream");
          return deps.runGit!(args, opts);
        },
      }),
      (err: unknown) => (err as OffloadError).code === "remove_missing_upstream",
    );

    await createOnePod("demo", "remove-unpushed", deps);
    assert.throws(
      () => removeOffloadPod("demo", "remove-unpushed", {}, {
        ...deps,
        runGit: (args, opts) => {
          if (args[0] === "merge-base") return fail("not ancestor");
          return deps.runGit!(args, opts);
        },
      }),
      (err: unknown) => (err as OffloadError).code === "remove_unpushed_repo",
    );

    await createOnePod("demo", "remove-force", deps);
    assert.throws(
      () => removeOffloadPod("demo", "remove-force", { force: true, confirm: "wrong/pod" }, deps),
      (err) => (err as OffloadError).code === "force_confirmation_required",
    );
    const removed = removeOffloadPod("demo", "remove-force", { force: true, confirm: "demo/remove-force" }, deps);
    assert.equal(removed.removed, true);
    assert.ok(!existsSync(offloadPaths("demo", "remove-force", deps).podRoot));

    await createOnePod("demo", "remove-missing-compose", deps);
    rmSync(offloadPaths("demo", "remove-missing-compose", deps).composeFile);
    assert.throws(
      () => removeOffloadPod("demo", "remove-missing-compose", {
        force: true,
        confirm: "demo/remove-missing-compose",
      }, deps),
      (err: unknown) => (err as OffloadError).code === "pod_compose_missing",
    );
  } finally {
    roots.cleanup();
  }
});

test("hidden stop-all stops all managed containers in deterministic order without deleting state", async () => {
  const roots = tempRoots();
  try {
    const deps = makeDeps({ assetRoot: roots.assetRoot, stateRoot: roots.stateRoot });
    const b = await createOnePod("beta", "two", deps);
    const a = await createOnePod("alpha", "one", deps);
    deps.dockerRunning.push(
      { name: b.resources.containerName, stack: "beta", pod: "two" },
      { name: a.resources.containerName, stack: "alpha", pod: "one" },
    );

    const result = stopAllOffloadPods(deps);
    assert.deepEqual(result.stopped.map((pod) => `${pod.stack}/${pod.pod}`), ["alpha/one", "beta/two"]);
    assert.equal(readMeta("alpha", "one", deps).status, "stopped");
    assert.equal(readMeta("beta", "two", deps).status, "stopped");
    assert.ok(existsSync(join(offloadPaths("alpha", "one", deps).reposRoot, "api")));
    assert.ok(existsSync(join(offloadPaths("beta", "two", deps).reposRoot, "api")));
  } finally {
    roots.cleanup();
  }
});
