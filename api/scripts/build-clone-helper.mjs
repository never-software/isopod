import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(here, "..");
const source = join(apiRoot, "bin", "clone.c");
const output = join(apiRoot, "bin", "clone");

if (!existsSync(source)) {
  console.error(`clone helper source not found: ${source}`);
  process.exit(1);
}

const compiler = process.env.CC || "cc";
const result = spawnSync(compiler, ["-O2", "-o", output, source], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
