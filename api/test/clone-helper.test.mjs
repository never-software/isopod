import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = join(apiRoot, "bin", "clone");

test("native clone helper is compiled and fails clearly on invalid usage", () => {
  assert.equal(existsSync(helper), true, `clone helper missing at ${helper}`);
  const usage = spawnSync(helper, [], { encoding: "utf-8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage:/);
});

test("native clone helper performs an APFS directory clone on macOS", {
  skip: process.platform !== "darwin",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "isopod-clone-helper-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "probe"), "clone helper proof\n");

    const result = spawnSync(helper, [source, destination], { encoding: "utf-8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(destination, "probe")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
