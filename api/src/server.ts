import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "fs";
import { resolve, join, extname } from "path";
import { config } from "./config.js";
import { listPods, createPod, podUp, podDown, podExists } from "./pods.js";
import { discoverRepos } from "./repos.js";
import { defaultBranchFor } from "./git.js";
import { dbList } from "./db.js";
import { getStatus, deleteCollection, deleteBranch, getCollectionBranches, getAllBranches } from "./indexer/qdrant.js";
import { discoverWatchTargets, startDaemon, stopDaemon, getDisabledTargets, toggleTarget, setDisabledTargets, targetKey } from "./indexer/watcher.js";

// ── Server ──────────────────────────────────────────────────────────

export async function startServer(port: number): Promise<void> {
  const dashboardDir = resolve(config.apiRoot, "..", "ui", "dist");

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

  if (method === "POST") {
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
    if (upMatch) return apiPodUp(res, decodeURIComponent(upMatch[1]));

    const downMatch = path.match(/^\/api\/pods\/(.+)\/down$/);
    if (downMatch) return apiPodDown(res, decodeURIComponent(downMatch[1]));
  }

  json(res, 404, { error: "Not found" });
}

// ── API Handlers ────────────────────────────────────────────────────

function apiPods(res: ServerResponse): void {
  const pods = listPods();
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
  const repoNames = discoverRepos();
  const repos = repoNames
    .filter((name) => existsSync(join(config.reposDir, name, ".git")))
    .map((name) => {
      const repoPath = join(config.reposDir, name);
      const branch = defaultBranchFor(repoPath);
      return { name, defaultBranch: branch };
    });

  json(res, 200, repos);
}

function apiPodExists(res: ServerResponse, name: string): void {
  json(res, 200, { exists: podExists(name) });
}

async function apiCreatePod(res: ServerResponse, body: any): Promise<void> {
  const { name, repos, from } = body;

  if (!name || typeof name !== "string" || !name.trim()) {
    json(res, 400, { error: "Pod name is required" });
    return;
  }

  if (podExists(name)) {
    json(res, 409, { error: `Pod '${name}' already exists` });
    return;
  }

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

  try {
    await createPod(name, {
      repos: repos && repos.length > 0 ? repos : undefined,
      from,
      onLog: (line: string) => sse("log", { line }),
    });
    sse("done", { success: true });
  } catch (error: any) {
    sse("error", { message: error.message });
  }

  res.end();
}

function apiSnapshots(res: ServerResponse): void {
  const snapshots = dbList();
  json(res, 200, snapshots);
}

async function apiPodUp(res: ServerResponse, podName: string): Promise<void> {
  try {
    await podUp(podName);
    json(res, 200, { ok: true, output: "" });
  } catch (error: any) {
    json(res, 500, { error: `Failed to up pod`, output: error.message });
  }
}

function apiPodDown(res: ServerResponse, podName: string): void {
  try {
    podDown(podName);
    json(res, 200, { ok: true, output: "" });
  } catch (error: any) {
    json(res, 500, { error: `Failed to down pod`, output: error.message });
  }
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

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
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

function tailFile(filePath: string, lines: number): string[] {
  const stat = statSync(filePath);
  const bufferSize = Math.min(stat.size, 65536);
  const buffer = Buffer.alloc(bufferSize);

  const fd = openSync(filePath, "r");
  readSync(fd, buffer, 0, bufferSize, Math.max(0, stat.size - bufferSize));
  closeSync(fd);

  const content = buffer.toString("utf-8");
  const allLines = content.split("\n").filter(Boolean);
  return allLines.slice(-lines);
}
