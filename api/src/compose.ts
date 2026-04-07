import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import { config } from "./config.js";

/**
 * Generate (or regenerate) docker-compose.yml for a pod from the current template.
 * Detects repos from the pod directory automatically.
 */
export function generateCompose(featureName: string): void {
  const podDir = join(config.podsDir, featureName);
  const dockerDir = config.dockerDir;
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
          }).trim();
          if (extra) {
            repoVolumes += extra + "\n";
          }
        } catch { /* ignore hook failures */ }
      }
    }
  }
  repoVolumes = repoVolumes.replace(/\n$/, "");

  // Generate home template volume mounts
  let homeVolumes = "";
  const homeTemplateDir = resolve(config.isopodRoot, "pod_home_template");
  if (existsSync(homeTemplateDir)) {
    for (const entry of readdirSync(homeTemplateDir, { withFileTypes: true })) {
      const itemPath = join(homeTemplateDir, entry.name);
      homeVolumes += `      - ${itemPath}:/root/${entry.name}:delegated\n`;
      homeVolumes += `      - ${itemPath}:/home/dev/${entry.name}:delegated\n`;
    }
    homeVolumes = homeVolumes.replace(/\n$/, "");
  }

  // Generate workspace template volume mounts
  let workspaceTemplateVolumes = "";
  const workspaceTemplateDir = resolve(config.isopodRoot, "pod_workspace_template");
  if (existsSync(workspaceTemplateDir)) {
    for (const entry of readdirSync(workspaceTemplateDir, { withFileTypes: true })) {
      if (entry.name === ".gitkeep") continue;
      const itemPath = join(workspaceTemplateDir, entry.name);
      workspaceTemplateVolumes += `      - ${itemPath}:/workspace/${entry.name}:delegated\n`;
    }
    workspaceTemplateVolumes = workspaceTemplateVolumes.replace(/\n$/, "");
  }

  // Read template and substitute
  let template = readFileSync(templateFile, "utf-8");
  const repoList = repos.join(",");

  // Replace line-based placeholders
  template = template
    .split("\n")
    .map((line) => {
      if (line.includes("__REPO_VOLUMES__")) return repoVolumes;
      if (line.includes("__HOME_TEMPLATE_VOLUMES__")) return homeVolumes;
      if (line.includes("__WORKSPACE_TEMPLATE_VOLUMES__")) return workspaceTemplateVolumes;
      return line
        .replace(/__FEATURE_NAME__/g, featureName)
        .replace(/__DOCKER_DIR__/g, dockerDir)
        .replace(/__IMAGE_NAME__/g, config.workspaceImage)
        .replace(/__REPO_LIST__/g, repoList);
    })
    .join("\n");

  const composeFile = join(podDir, "docker-compose.yml");
  writeFileSync(composeFile, template);
}
