import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { config } from "./config.js";
import { containerName } from "./docker.js";
import { sharedWorkspaceMounts, sharedHomeMounts } from "./sharing.js";

/**
 * Generate (or regenerate) docker-compose.yml for a pod from the current template.
 * Detects repos from the pod directory automatically.
 */
export function generateCompose(
  featureName: string,
  opts: { stack: string },
): void {
  const { stack } = opts;
  const podDir = join(config.stackPodsDir(stack), featureName);
  const dockerDir = config.stackDockerDir(stack);
  const imageName = config.imageFor(stack);
  const templateFile = join(dockerDir, "docker-compose.template.yml");

  // Detect repos from pod directory (directories with .git)
  const repos: string[] = [];
  if (existsSync(podDir)) {
    for (const entry of readdirSync(podDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(podDir, entry.name, ".git"))) {
        repos.push(entry.name);
      }
    }
  }

  // Build repo volumes
  let repoVolumes = "";
  const repoVolumesHook = join(dockerDir, "hooks", "repo-volumes");
  for (const dirName of repos) {
    if (existsSync(join(podDir, dirName))) {
      repoVolumes += `      - ./${dirName}:/workspace/${dirName}:delegated\n`;
      if (existsSync(repoVolumesHook)) {
        try {
          const extra = execSync(repoVolumesHook, {
            encoding: "utf-8",
            timeout: 10000,
            env: { ...process.env, REPO_NAME: dirName, POD_DIR: podDir },
          }).trimEnd();
          if (extra) {
            repoVolumes += extra + "\n";
          }
        } catch { /* ignore hook failures */ }
      }
    }
  }
  repoVolumes = repoVolumes.replace(/\n$/, "");

  // Mount the pod root as /workspace. Repos below override their subdirectories.
  // Entries marked "shared" in the stack's .workspace-sharing manifest get an
  // extra live overlay mount of the canonical template (edits flow back and
  // across pods); with no manifest this is just the root mount, exactly as before.
  const workspaceTemplateVolumes = [
    "      - .:/workspace:delegated",
    ...sharedWorkspaceMounts(stack),
  ].join("\n");

  // Shared home overlays. No root mount — /home/dev is the named `home:` volume,
  // already declared in the template; the home scope contributes overlay mounts
  // only. Empty by default, so the __HOME_TEMPLATE_VOLUMES__ line is dropped
  // entirely (not left as a blank YAML line) when nothing is shared.
  const homeTemplateVolumes = sharedHomeMounts(stack);

  // Read template and substitute
  let template = readFileSync(templateFile, "utf-8");
  const repoList = repos.join(",");

  // Replace line-based placeholders (flatMap so an empty home placeholder drops)
  template = template
    .split("\n")
    .flatMap((line) => {
      if (line.includes("__REPO_VOLUMES__")) return [repoVolumes];
      if (line.includes("__WORKSPACE_TEMPLATE_VOLUMES__")) return [workspaceTemplateVolumes];
      if (line.includes("__HOME_TEMPLATE_VOLUMES__")) return homeTemplateVolumes;
      return [line
        .replace(/__CONTAINER_NAME__/g, containerName(featureName, stack))
        .replace(/__FEATURE_NAME__/g, featureName)
        .replace(/__STACK_NAME__/g, stack)
        .replace(/__DOCKER_DIR__/g, dockerDir)
        .replace(/__IMAGE_NAME__/g, imageName)
        .replace(/__REPO_LIST__/g, repoList)];
    })
    .join("\n");

  const composeFile = join(podDir, "docker-compose.yml");
  writeFileSync(composeFile, template);
}
