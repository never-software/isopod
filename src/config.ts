import { resolve, basename, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findIsopodRoot(): string {
  // Walk up from src/ to find the isopod root (has `isopod` script + `repos/` dir)
  let dir = resolve(__dirname, "..");
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "isopod")) && existsSync(resolve(dir, "repos"))) {
      return dir;
    }
    dir = resolve(dir, "..");
  }
  return process.env.ISOPOD_ROOT || resolve(__dirname, "..");
}

export const config = {
  get isopodRoot() {
    return findIsopodRoot();
  },
  get reposDir() {
    return resolve(this.isopodRoot, "repos");
  },
  get podsDir() {
    return resolve(this.isopodRoot, "pods");
  },
  get dockerDir() {
    const localDir = resolve(this.isopodRoot, "docker.local");
    if (existsSync(localDir)) return localDir;
    return resolve(this.isopodRoot, "docker");
  },
  get projectName() {
    return basename(this.isopodRoot);
  },
  get workspaceImage() {
    return `${this.projectName}-workspace`;
  },
  get port() {
    return parseInt(process.env.ISOPOD_PORT || "3141", 10);
  },
  get dataDir() {
    return resolve(this.isopodRoot, ".isopod");
  },
  get pidFile() {
    return resolve(this.dataDir, "server.pid");
  },
  get logFile() {
    return resolve(this.dataDir, "server.log");
  },
  get dashboardDir() {
    return resolve(this.isopodRoot, "indexer", "dist", "dashboard");
  },
};

export type Config = typeof config;
