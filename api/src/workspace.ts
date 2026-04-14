import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, basename } from "path";

/**
 * Run post-workspace hook after container is ready.
 */
export function setupWorkspace(podDir: string, onLog?: (msg: string) => void, dockerDir?: string): void {
  const featureName = basename(podDir);
  const hookDir = dockerDir!;
  const hook = join(hookDir, "hooks", "post-workspace");

  if (existsSync(hook)) {
    try {
      execSync(hook, {
        timeout: 60000,
        stdio: "pipe",
        env: { ...process.env, POD_DIR: podDir, FEATURE_NAME: featureName, DOCKER_DIR: hookDir },
      });
    } catch { /* ignore hook failures */ }
  }

  onLog?.("Workspace ready");
}

/**
 * Run teardown-workspace hook before stopping.
 */
export function teardownWorkspace(featureName: string, opts?: { removing?: boolean }, dockerDir?: string): void {
  const hookDir = dockerDir!;
  const hook = join(hookDir, "hooks", "teardown-workspace");

  if (existsSync(hook)) {
    try {
      execSync(hook, {
        timeout: 60000,
        stdio: "pipe",
        env: {
          ...process.env,
          FEATURE_NAME: featureName,
          DOCKER_DIR: hookDir,
          ...(opts?.removing && { ISOPOD_REMOVING: "true" }),
        },
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
export function getUrls(featureName: string, dockerDir?: string): UrlInfo[] {
  const hookDir = dockerDir!;
  const hook = join(hookDir, "hooks", "urls");
  if (!existsSync(hook)) return [];

  let output: string;
  try {
    output = execSync(hook, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, FEATURE_NAME: featureName, DOCKER_DIR: hookDir },
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
export async function waitForUrls(
  featureName: string,
  timeout = 600,
  dockerDir?: string,
  onLog?: (msg: string) => void,
): Promise<UrlInfo[]> {
  const hookDir = dockerDir!;
  const hook = join(hookDir, "hooks", "urls");
  if (!existsSync(hook)) return [];

  let output: string;
  try {
    output = execSync(hook, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, FEATURE_NAME: featureName, DOCKER_DIR: hookDir },
    }).trim();
  } catch {
    return [];
  }

  if (!output) return [];

  const lines = output.split("\n");
  const firstParts = lines[0]?.split("\t") ?? [];
  const firstLabel = firstParts[0] || "service";
  const firstUrl = firstParts[1];

  if (firstUrl) {
    onLog?.(`Waiting for ${firstLabel} at ${firstUrl}...`);
    let ready = false;
    let lastProgressAt = 0;
    for (let elapsed = 0; elapsed < timeout; elapsed += 3) {
      try {
        execSync(`curl -sk --connect-timeout 2 --max-time 3 "${firstUrl}" -o /dev/null`, {
          stdio: "ignore",
          timeout: 5000,
        });
        ready = true;
        break;
      } catch { /* not ready yet */ }
      if (elapsed > 0 && elapsed - lastProgressAt >= 15) {
        onLog?.(`Still waiting for ${firstLabel}... (${elapsed}s elapsed)`);
        lastProgressAt = elapsed;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (ready) {
      onLog?.(`${firstLabel} is responding`);
    } else {
      onLog?.(`${firstLabel} did not respond within ${timeout}s — continuing anyway`);
    }
  }

  return getUrls(featureName, dockerDir);
}
