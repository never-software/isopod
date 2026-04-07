import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, basename } from "path";
import { config } from "./config.js";

/**
 * Run post-workspace hook after container is ready.
 */
export function setupWorkspace(podDir: string, onLog?: (msg: string) => void): void {
  const featureName = basename(podDir);
  const hook = join(config.dockerDir, "hooks", "post-workspace");

  if (existsSync(hook)) {
    try {
      execSync(hook, {
        timeout: 60000,
        stdio: "pipe",
        env: { ...process.env, POD_DIR: podDir, FEATURE_NAME: featureName },
      });
    } catch { /* ignore hook failures */ }
  }

  onLog?.("Workspace ready");
}

/**
 * Run teardown-workspace hook before stopping.
 */
export function teardownWorkspace(featureName: string): void {
  const hook = join(config.dockerDir, "hooks", "teardown-workspace");

  if (existsSync(hook)) {
    try {
      execSync(hook, {
        timeout: 60000,
        stdio: "pipe",
        env: { ...process.env, FEATURE_NAME: featureName },
      });
    } catch { /* ignore hook failures */ }
  }
}

export interface UrlInfo {
  label: string;
  url: string;
  responding: boolean;
}

/**
 * Get URLs from the urls hook and check their readiness.
 */
export function getUrls(featureName: string): UrlInfo[] {
  const hook = join(config.dockerDir, "hooks", "urls");
  if (!existsSync(hook)) return [];

  let output: string;
  try {
    output = execSync(hook, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, FEATURE_NAME: featureName },
    }).trim();
  } catch {
    return [];
  }

  if (!output) return [];

  const urls: UrlInfo[] = [];
  for (const line of output.split("\n")) {
    const parts = line.split("\t");
    if (parts.length >= 2) {
      let responding = false;
      try {
        execSync(`curl -sk --connect-timeout 2 --max-time 3 "${parts[1]}" -o /dev/null`, {
          stdio: "ignore",
          timeout: 5000,
        });
        responding = true;
      } catch { /* not responding */ }
      urls.push({ label: parts[0], url: parts[1], responding });
    }
  }

  return urls;
}

/**
 * Wait for the first URL to become available, with timeout.
 */
export function waitForUrls(featureName: string, timeout = 600): UrlInfo[] {
  const hook = join(config.dockerDir, "hooks", "urls");
  if (!existsSync(hook)) return [];

  let output: string;
  try {
    output = execSync(hook, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, FEATURE_NAME: featureName },
    }).trim();
  } catch {
    return [];
  }

  if (!output) return [];

  const lines = output.split("\n");
  const firstUrl = lines[0]?.split("\t")[1];

  if (firstUrl) {
    for (let elapsed = 0; elapsed < timeout; elapsed += 3) {
      try {
        execSync(`curl -sk --connect-timeout 2 --max-time 3 "${firstUrl}" -o /dev/null`, {
          stdio: "ignore",
          timeout: 5000,
        });
        break;
      } catch { /* not ready yet */ }
      execSync("sleep 3");
    }
  }

  return getUrls(featureName);
}
