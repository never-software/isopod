import { execSync } from "child_process";
import { runHook, runHookCapture } from "./hooks.js";
import type { OperationEvent } from "../types.js";

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

/**
 * Run the urls hook, wait for the first URL to become reachable, and yield URL info.
 * Matches the shell display_urls behavior.
 */
export async function* displayUrls(featureName: string): AsyncGenerator<OperationEvent> {
  const output = runHookCapture("urls", { FEATURE_NAME: featureName });
  if (!output?.trim()) return;

  const entries: Array<{ label: string; url: string }> = [];
  for (const line of output.trim().split("\n")) {
    const [label, url] = line.split("\t");
    if (label && url) entries.push({ label, url });
  }

  if (entries.length === 0) return;

  // Wait for first URL to become reachable (up to 60s)
  const firstUrl = entries[0]!.url;
  const timeout = 60;
  for (let t = 0; t < timeout; t += 3) {
    try {
      execSync(`curl -sk --connect-timeout 2 --max-time 3 "${firstUrl}" -o /dev/null`, {
        stdio: "ignore",
        timeout: 10000,
      });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Yield URL info
  const lines = entries.map((e) => {
    let reachable = false;
    try {
      execSync(`curl -sk --connect-timeout 2 --max-time 3 "${e.url}" -o /dev/null`, {
        stdio: "ignore",
        timeout: 10000,
      });
      reachable = true;
    } catch { /* not reachable */ }
    return `  ${e.label.padEnd(14)} ${e.url}${reachable ? "" : " (not responding)"}`;
  });

  yield {
    type: "info",
    message: `Services:\n${lines.join("\n")}`,
  };
}
