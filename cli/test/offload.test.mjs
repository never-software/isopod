import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function runCli(args) {
  const root = mkdtempSync(join(tmpdir(), "isopod-offload-cli-"));
  try {
    return spawnSync(process.execPath, ["dist/index.js", ...args], {
      cwd: cliRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        ISOPOD_ASSET_ROOT: join(root, "assets"),
        ISOPOD_STATE_ROOT: join(root, "state"),
        ISOPOD_OFFLOAD_LOCK_HELD: "",
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("offload create parses SSH repo URLs and emits stable JSON lock errors", () => {
  const result = runCli([
    "offload",
    "create",
    "demo",
    "pod",
    "--repo",
    "api=git@example.test:org/repo.git",
    "--ref",
    "api=refs/heads/main",
    "--json",
  ]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.ok, false);
  assert.equal(body.operation, "create");
  assert.equal(body.error.code, "offload_lock_required");
});

test("hidden offload stop-all is present but lock-gated", () => {
  const result = runCli(["offload", "stop-all", "--json"]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.ok, false);
  assert.equal(body.operation, "stop-all");
  assert.equal(body.error.code, "offload_lock_required");
});

test("offload doctor emits its full JSON report and exits non-zero when unhealthy", () => {
  const result = runCli(["offload", "doctor", "--json"]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.ok, true);
  assert.equal(body.operation, "doctor");
  assert.equal(body.result.healthy, false);
  assert.ok(body.result.checks.some((check) => check.ok === false));
});
