import { runHook } from "./hooks.js";
import { config } from "../config.js";

/**
 * Run post-workspace setup hook.
 */
export function setupWorkspace(podDir: string, featureName: string): void {
  runHook("post-workspace", {
    POD_DIR: podDir,
    FEATURE_NAME: featureName,
  });
}

/**
 * Run teardown-workspace hook.
 */
export function teardownWorkspace(
  featureName: string,
  opts: { removing?: boolean } = {},
): void {
  const env: Record<string, string> = {
    FEATURE_NAME: featureName,
  };
  if (opts.removing) {
    env.ISOPOD_REMOVING = "true";
  }
  runHook("teardown-workspace", env);
}
