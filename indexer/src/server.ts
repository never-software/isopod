import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, readdirSync } from "fs";
import { resolve, join, extname } from "path";
import { execSync, exec, spawn } from "child_process";
import { config } from "./config.js";
import { getStatus, deleteCollection, deleteBranch, getCollectionBranches, getAllBranches } from "./qdrant.js";
import { discoverWatchTargets, startDaemon, stopDaemon, getDisabledTargets, toggleTarget, setDisabledTargets, targetKey } from "./watcher.js";

// ── Server ──────────────────────────────────────────────────────────

export async function startServer(port: number): Promise<void> {
  const dashboardDir = resolve(config.indexerRoot, "dist", "dashboard");

  const server = createServer(async (req, res) => {
    try {
      if (req.url?.startsWith("/api/")) {
        await handleApi(req, res);
      } else {
        serveStatic(req, res, dashboardDir);
      }
    } catch (error: any) {
      json(res, 500, { error: error.message });
    }
  });

  server.listen(port, () => {
    console.log(`Isopod dashboard running at http://localhost:${port}`);
    console.log("Press Ctrl-C to stop.\n");
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down dashboard...");
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ── API Router ──────────────────────────────────────────────────────

async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method || "GET";

  // GET endpoints
  if (method === "GET") {
    if (path === "/api/pods") return apiPods(res);
    if (path === "/api/daemon") return apiDaemon(res);
    if (path === "/api/collections") return apiCollections(res);
    if (path === "/api/branches") return apiBranches(res);
    if (path === "/api/logs") return apiLogs(res, url);
    if (path === "/api/watch-targets") return apiWatchTargets(res);
    if (path === "/api/watch-targets/disabled") return apiDisabledTargets(res);
    if (path === "/api/snapshots") return apiSnapshots(res);
    if (path === "/api/repos") return apiRepos(res);

    const branchesMatch = path.match(/^\/api\/collection\/(.+)\/branches$/);
    if (branchesMatch) return apiCollectionBranches(res, decodeURIComponent(branchesMatch[1]));

    const collectionMatch = path.match(/^\/api\/collection\/([^/]+)$/);
    if (collectionMatch) return apiCollectionDetail(res, decodeURIComponent(collectionMatch[1]));

    const existsMatch = path.match(/^\/api\/pods\/(.+)\/exists$/);
    if (existsMatch) return apiPodExists(res, decodeURIComponent(existsMatch[1]));
  }

  // POST endpoints
  if (method === "POST") {
    // SSE endpoint — read body before switching to stream mode
    if (path === "/api/pods/create") {
      const body = await readBody(req);
      return apiCreatePod(res, body);
    }

    const body = await readBody(req);

    if (path === "/api/daemon/start") return apiDaemonStart(res);
    if (path === "/api/daemon/stop") return apiDaemonStop(res);

    if (path === "/api/watch-targets/toggle") return apiToggleTarget(res, body);
    if (path === "/api/watch-targets/toggle-pod") return apiTogglePod(res, body);
    if (path === "/api/collections/delete-all") return apiDeleteAllCollections(res);

    const deleteColMatch = path.match(/^\/api\/collection\/(.+)\/delete$/);
    if (deleteColMatch) return apiDeleteCollection(res, decodeURIComponent(deleteColMatch[1]));

    const deleteBranchMatch = path.match(/^\/api\/collection\/(.+)\/delete-branch$/);
    if (deleteBranchMatch) return apiDeleteBranch(res, decodeURIComponent(deleteBranchMatch[1]), body);

    const upMatch = path.match(/^\/api\/pods\/(.+)\/up$/);
    if (upMatch) return apiPodAction(res, decodeURIComponent(upMatch[1]), "up");

    const downMatch = path.match(/^\/api\/pods\/(.+)\/down$/);
    if (downMatch) return apiPodAction(res, decodeURIComponent(downMatch[1]), "down");
  }

  json(res, 404, { error: "Not found" });
}

// ── API Handlers ────────────────────────────────────────────────────

function apiPods(res: ServerResponse): void {
  const pods: PodInfo[] = [];

  if (!existsSync(config.podsDir)) {
    json(res, 200, pods);
    return;
  }

  // Get container statuses in one Docker call
  const containerStatuses = getContainerStatuses();

  // Sort by directory mtime, newest first
  const podNames = listDirs(config.podsDir).sort((a, b) => {
    try {
      return statSync(join(config.podsDir, b)).mtimeMs - statSync(join(config.podsDir, a)).mtimeMs;
    } catch { return 0; }
  });

  for (const podName of podNames) {
    const podDir = join(config.podsDir, podName);
    const repos: PodRepo[] = [];

    for (const repoName of listDirs(podDir)) {
      if (repoName.startsWith(".")) continue;
      const repoPath = join(podDir, repoName);
      if (!existsSync(join(repoPath, ".git"))) continue;

      let branch = "unknown";
      try {
        branch = execSync("git branch --show-current", {
          cwd: repoPath,
          encoding: "utf-8",
          timeout: 5000,
        }).trim() || "HEAD";
      } catch { /* ignore */ }

      repos.push({ name: repoName, branch });
    }

    // Match container status by pod name
    const status = containerStatuses.get(podName);

    pods.push({
      name: podName,
      repos,
      container: status || { state: "not created", status: "" },
    });
  }

  json(res, 200, pods);
}

async function apiCollections(res: ServerResponse): Promise<void> {
  const status = await getStatus();
  json(res, 200, status);
}

function apiDaemon(res: ServerResponse): void {
  if (!existsSync(config.pidFile)) {
    json(res, 200, { running: false, pid: null });
    return;
  }

  const pid = parseInt(readFileSync(config.pidFile, "utf-8").trim(), 10);

  try {
    process.kill(pid, 0);
    json(res, 200, { running: true, pid });
  } catch {
    json(res, 200, { running: false, pid: null });
  }
}

async function apiDaemonStart(res: ServerResponse): Promise<void> {
  try {
    await startDaemon();
    json(res, 200, { ok: true });
  } catch (error: any) {
    json(res, 500, { error: error.message });
  }
}

function apiDaemonStop(res: ServerResponse): void {
  try {
    stopDaemon();
    json(res, 200, { ok: true });
  } catch (error: any) {
    json(res, 500, { error: error.message });
  }
}

async function apiDeleteCollection(res: ServerResponse, name: string): Promise<void> {
  try {
    await deleteCollection(name);
    json(res, 200, { ok: true });
  } catch (error: any) {
    json(res, 500, { error: error.message });
  }
}

async function apiDeleteBranch(res: ServerResponse, name: string, body: any): Promise<void> {
  if (!body.branch) {
    json(res, 400, { error: "Missing 'branch'" });
    return;
  }
  try {
    await deleteBranch(name, body.branch);
    json(res, 200, { ok: true });
  } catch (error: any) {
    json(res, 500, { error: error.message });
  }
}

async function apiDeleteAllCollections(res: ServerResponse): Promise<void> {
  try {
    const status = await getStatus();
    for (const col of status) {
      await deleteCollection(col.name);
    }
    json(res, 200, { ok: true, deleted: status.length });
  } catch (error: any) {
    json(res, 500, { error: error.message });
  }
}

function apiLogs(res: ServerResponse, url: URL): void {
  const n = parseInt(url.searchParams.get("n") || "100", 10);

  if (!existsSync(config.logFile)) {
    json(res, 200, { lines: [] });
    return;
  }

  // Read last 64KB to avoid loading the whole file
  const lines = tailFile(config.logFile, n);
  json(res, 200, { lines });
}

function apiWatchTargets(res: ServerResponse): void {
  const targets = discoverWatchTargets();
  const disabled = getDisabledTargets();
  const enriched = targets.map((t) => ({ ...t, enabled: !disabled.has(targetKey(t)) }));
  json(res, 200, enriched);
}

function apiDisabledTargets(res: ServerResponse): void {
  json(res, 200, Array.from(getDisabledTargets()));
}

function apiToggleTarget(res: ServerResponse, body: any): void {
  if (!body.collectionName || !body.branch) {
    json(res, 400, { error: "Missing 'collectionName' or 'branch'" });
    return;
  }
  const enabled = toggleTarget(body.collectionName, body.branch);
  json(res, 200, { collectionName: body.collectionName, branch: body.branch, enabled });
}

function apiTogglePod(res: ServerResponse, body: any): void {
  if (!body.podName || body.enabled === undefined) {
    json(res, 400, { error: "Missing 'podName' or 'enabled'" });
    return;
  }
  const targets = discoverWatchTargets().filter((t) => t.podName === body.podName);
  const disabled = getDisabledTargets();

  for (const t of targets) {
    const key = targetKey(t);
    if (body.enabled) {
      disabled.delete(key);
    } else {
      disabled.add(key);
    }
  }
  setDisabledTargets(disabled);
  json(res, 200, { podName: body.podName, enabled: body.enabled, toggled: targets.length });
}

async function apiCollectionDetail(res: ServerResponse, name: string): Promise<void> {
  // Use getStatus to verify collection exists
  const allStatus = await getStatus();
  const collection = allStatus.find((c) => c.name === name);

  if (!collection) {
    json(res, 404, { error: `Collection '${name}' not found` });
    return;
  }

  json(res, 200, collection);
}

async function apiBranches(res: ServerResponse): Promise<void> {
  try {
    const branches = await getAllBranches();
    json(res, 200, branches);
  } catch (error: any) {
    json(res, 500, { error: error.message });
  }
}

async function apiCollectionBranches(res: ServerResponse, name: string): Promise<void> {
  try {
    const branches = await getCollectionBranches(name);
    json(res, 200, branches);
  } catch (error: any) {
    json(res, 500, { error: error.message });
  }
}


function apiRepos(res: ServerResponse): void {
  if (!existsSync(config.reposDir)) {
    json(res, 200, []);
    return;
  }

  const repos = listDirs(config.reposDir)
    .filter((name) => existsSync(join(config.reposDir, name, ".git")))
    .map((name) => {
      const repoPath = join(config.reposDir, name);
      let defaultBranch = "main";
      try {
        const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
          cwd: repoPath,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        defaultBranch = ref.replace("refs/remotes/origin/", "");
      } catch {
        // Check if origin/main or origin/master exist
        try {
          execSync("git rev-parse --verify origin/main", { cwd: repoPath, stdio: "ignore", timeout: 5000 });
          defaultBranch = "main";
        } catch {
          try {
            execSync("git rev-parse --verify origin/master", { cwd: repoPath, stdio: "ignore", timeout: 5000 });
            defaultBranch = "master";
          } catch { /* fallback to "main" */ }
        }
      }
      return { name, defaultBranch };
    });

  json(res, 200, repos);
}

function apiPodExists(res: ServerResponse, name: string): void {
  const exists = existsSync(join(config.podsDir, name));
  json(res, 200, { exists });
}

function apiCreatePod(res: ServerResponse, body: any): void {
  const { name, repos, from } = body;

  if (!name || typeof name !== "string" || !name.trim()) {
    json(res, 400, { error: "Pod name is required" });
    return;
  }

  if (existsSync(join(config.podsDir, name))) {
    json(res, 409, { error: `Pod '${name}' already exists` });
    return;
  }

  // Build the isopod create command
  const isopodBin = resolve(config.isopodRoot, "isopod");
  const args = ["create", name];
  if (repos && repos.length > 0) args.push(...repos);
  if (from) args.push("--from", from);

  // Switch to SSE mode
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const sse = (type: string, data: any) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  sse("log", { line: `Creating pod: ${name}` });

  const child = spawn(isopodBin, args, {
    env: { ...process.env, TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Auto-accept any prompts (like DB clone)
  child.stdin?.write("y\n");
  child.stdin?.end();

  const handleOutput = (data: Buffer) => {
    const lines = stripAnsi(data.toString()).split("\n").filter(Boolean);
    for (const line of lines) {
      sse("log", { line });
    }
  };

  child.stdout?.on("data", handleOutput);
  child.stderr?.on("data", handleOutput);

  child.on("close", (code) => {
    if (code === 0) {
      sse("done", { success: true });
    } else {
      sse("error", { message: `Process exited with code ${code}` });
    }
    res.end();
  });

  child.on("error", (err) => {
    sse("error", { message: err.message });
    res.end();
  });

  // Clean up if client disconnects
  res.on("close", () => {
    if (!child.killed) child.kill();
  });
}

function apiSnapshots(res: ServerResponse): void {
  try {
    const output = execSync(
      'docker volume ls --filter name=isopod-snap- --format "{{.Name}}"',
      { encoding: "utf-8", timeout: 10000 }
    ).trim();

    if (!output) {
      json(res, 200, []);
      return;
    }

    const snapshots = output.split("\n").map((name) => {
      let created = "";
      try {
        const inspectOutput = execSync(
          `docker volume inspect ${name} --format "{{.CreatedAt}}"`,
          { encoding: "utf-8", timeout: 5000 }
        ).trim();
        created = inspectOutput.split("T")[0];
      } catch { /* ignore */ }

      // Strip "isopod-snap-" prefix for display name
      const displayName = name.replace(/^isopod-snap-/, "");

      return { name: displayName, volume: name, created };
    });

    json(res, 200, snapshots);
  } catch {
    json(res, 200, []);
  }
}

function apiPodAction(res: ServerResponse, podName: string, action: "up" | "down"): void {
  const isopodBin = resolve(config.isopodRoot, "isopod");

  exec(`"${isopodBin}" ${action} "${podName}"`, { timeout: 120000 }, (error, stdout, stderr) => {
    const output = stripAnsi((stdout || "") + (stderr || ""));

    if (error) {
      json(res, 500, { error: `Failed to ${action} pod`, output });
    } else {
      json(res, 200, { ok: true, output });
    }
  });
}

// ── Static file serving ─────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): void {
  let filePath = join(root, req.url === "/" ? "index.html" : req.url!);

  // Security: prevent directory traversal
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback — serve index.html for unmatched routes
    filePath = join(root, "index.html");
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end("Dashboard not built. Run: cd ui && npm run build");
      return;
    }
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = readFileSync(filePath);

  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

// ── Helpers ─────────────────────────────────────────────────────────

interface PodRepo {
  name: string;
  branch: string;
}

interface ContainerStatus {
  state: string;
  status: string;
}

interface PodInfo {
  name: string;
  repos: PodRepo[];
  container: ContainerStatus;
}

function json(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function getContainerStatuses(): Map<string, ContainerStatus> {
  const statuses = new Map<string, ContainerStatus>();

  try {
    const output = execSync(
      'docker ps -a --format "{{.Names}}\t{{.State}}\t{{.Status}}" --filter name=isopod-',
      { encoding: "utf-8", timeout: 10000 }
    ).trim();

    if (!output) return statuses;

    for (const line of output.split("\n")) {
      const [name, state, status] = line.split("\t");
      if (!name) continue;

      // Container names are like "isopod-podname-workspace-1"
      // Extract pod name by removing prefix and suffix
      const match = name.match(/^isopod-(.+?)[-_]/);
      if (match) {
        statuses.set(match[1], { state, status });
      }
    }
  } catch { /* Docker not running or no containers */ }

  return statuses;
}

function tailFile(filePath: string, lines: number): string[] {
  const stat = statSync(filePath);
  const bufferSize = Math.min(stat.size, 65536); // 64KB
  const buffer = Buffer.alloc(bufferSize);

  const fd = openSync(filePath, "r");
  readSync(fd, buffer, 0, bufferSize, Math.max(0, stat.size - bufferSize));
  closeSync(fd);

  const content = buffer.toString("utf-8");
  const allLines = content.split("\n").filter(Boolean);
  return allLines.slice(-lines);
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[\d*(;\d+)*m/g, "");
}
