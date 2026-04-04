import { execSync } from "child_process";
import { existsSync, accessSync, constants } from "fs";
import { resolve } from "path";
import { config } from "../config.js";

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a hook script if it exists and is executable.
 * Returns true if the hook was found and executed.
 */
export function runHook(
  hookName: string,
  env: Record<string, string> = {},
): boolean {
  const hookPath = resolve(config.dockerDir, "hooks", hookName);
  if (!existsSync(hookPath) || !isExecutable(hookPath)) return false;

  execSync(hookPath, {
    env: { ...process.env, ...env },
    stdio: "inherit",
    timeout: 300000, // 5 min timeout
  });

  return true;
}

/**
 * Run a hook script, returning its stdout.
 * Returns null if the hook doesn't exist.
 */
export function runHookCapture(
  hookName: string,
  env: Record<string, string> = {},
): string | null {
  const hookPath = resolve(config.dockerDir, "hooks", hookName);
  if (!existsSync(hookPath) || !isExecutable(hookPath)) return null;

  return execSync(hookPath, {
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 300000,
  });
}

/**
 * Check if a hook exists.
 */
export function hookExists(hookName: string): boolean {
  return existsSync(resolve(config.dockerDir, "hooks", hookName));
}
