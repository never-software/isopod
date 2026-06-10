import { execFileSync } from "child_process";

/**
 * docker exec user flags for a workspace container. Stacks like orri run
 * everything as a first-class 'dev' user; scaffold/example images run as the
 * image default (root). Probe once per invocation and only pass -u when the
 * user actually exists, so exec/enter work against both kinds of image.
 */
export function containerUserArgs(container: string): string[] {
  try {
    execFileSync("docker", ["exec", container, "id", "-u", "dev"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return ["-u", "dev"];
  } catch {
    return [];
  }
}
