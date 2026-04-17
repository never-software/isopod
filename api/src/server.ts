import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync, truncateSync } from "fs";
import { resolve, join, extname } from "path";
import { config } from "./config.js";
import { listPods, createPod, podUp, podDown, podExists, validatePodName, getRemoveWarnings, removePod } from "./pods.js";
import { discoverRepos } from "./repos.js";
import { defaultBranchFor } from "./git.js";
import { dbList, dbSave } from "./db.js";
import { cacheList, cacheDelete, cacheDestroy } from "./cache.js";
import { buildAll } from "./docker.js";
import { getStatus, deleteCollection, deleteBranch, getCollectionBranches, getAllBranches } from "./indexer/qdrant.js";
import { discoverWatchTargets, startDaemon, stopDaemon, getDisabledTargets, toggleTarget, setDisabledTargets, targetKey } from "./indexer/watcher.js";

// ── Server ──────────────────────────────────────────────────────────

export async function startServer(port: number): Promise<void> {
  const dashboardDir = resolve(config.isopodRoot, "indexer", "dist", "dashboard");

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

  server.listen(port, async () => {
    console.log(`Isopod dashboard running at http://localhost:${port}`);
    console.log("Press Ctrl-C to stop.\n");

    const settings = getSettings();
    if (settings.autoStart) {
      console.log("Auto-starting indexer daemon...");
      try {
        await startDaemon();
      } catch (error: any) {
        console.error(`Failed to auto-start daemon: ${error.message}`);
      }
    }
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

  if (method === "OPTIONS") {
    json(res, 204, "");
    return;
  }

  if (method === "GET") {
    if (path === "/api/pods") return apiPods(res);
    if (path === "/api/daemon") return apiDaemon(res);
    if (path === "/api/collections") return apiCollections(res);
    if (path === "/api/branches") return apiBranches(res);
    if (path === "/api/logs") return apiLogs(res, url);
    if (path === "/api/watch-targets") return apiWatchTargets(res);
    if (path === "/api/watch-targets/disabled") return apiDisabledTargets(res);
    if (path === "/api/snapshots") return apiSnapshots(res);
    if (path === "/api/repos") return apiRepos(res, url);
    if (path === "/api/stacks") return apiStacks(res);
    if (path === "/api/settings") return apiGetSettings(res);
    if (path === "/api/cache") return apiCache(res, url);

    const branchesMatch = path.match(/^\/api\/collection\/(.+)\/branches$/);
    if (branchesMatch) return apiCollectionBranches(res, decodeURIComponent(branchesMatch[1]));

    const collectionMatch = path.match(/^\/api\/collection\/([^/]+)$/);
    if (collectionMatch) return apiCollectionDetail(res, decodeURIComponent(collectionMatch[1]));

    const existsMatch = path.match(/^\/api\/pods\/(.+)\/exists$/);
    if (existsMatch) return apiPodExists(res, decodeURIComponent(existsMatch[1]));

    const warningsMatch = path.match(/^\/api\/pods\/(.+)\/warnings$/);
    if (warningsMatch) return apiPodWarnings(res, decodeURIComponent(warningsMatch[1]));

    if (path === "/api/stacks/detail") return apiStacksDetail(res);
  }

  if (method === "POST") {
    if (path === "/api/pods/create") {
      const body = await readBody(req);
      return apiCreatePod(res, body);
    }

    if (path === "/api/snapshots/create") {
      const body = await readBody(req);
      return apiCreateSnapshot(res, body);
    }

    const body = await readBody(req);

    if (path === "/api/daemon/start") return apiDaemonStart(res);
    if (path === "/api/daemon/stop") return apiDaemonStop(res);
    if (path === "/api/logs/clear") return apiClearLogs(res);

    if (path === "/api/watch-targets/toggle") return apiToggleTarget(res, body);
    if (path === "/api/watch-targets/toggle-pod") return apiTogglePod(res, body);
    if (path === "/api/collections/delete-all") return apiDeleteAllCollections(res);
    if (path === "/api/settings") return apiUpdateSettings(res, body);
    if (path === "/api/cache/delete") return apiCacheDelete(res, body);
    if (path === "/api/cache/destroy") return apiCacheDestroy(res, body);

    const buildStackMatch = path.match(/^\/api\/stacks\/(.+)\/build$/);
    if (buildStackMatch) return apiStackBuild(res, decodeURIComponent(buildStackMatch[1]));

    const deleteColMatch = path.match(/^\/api\/collection\/(.+)\/delete$/);
    if (deleteColMatch) return apiDeleteCollection(res, decodeURIComponent(deleteColMatch[1]));

    const deleteBranchMatch = path.match(/^\/api\/collection\/(.+)\/delete-branch$/);
    if (deleteBranchMatch) return apiDeleteBranch(res, decodeURIComponent(deleteBranchMatch[1]), body);

    const upMatch = path.match(/^\/api\/pods\/(.+)\/up$/);
    if (upMatch) return apiPodUp(res, decodeURIComponent(upMatch[1]));

    const downMatch = path.match(/^\/api\/pods\/(.+)\/down$/);
    if (downMatch) return apiPodDown(res, decodeURIComponent(downMatch[1]));

    const removeMatch = path.match(/^\/api\/pods\/(.+)\/remove$/);
    if (removeMatch) return apiPodRemove(res, decodeURIComponent(removeMatch[1]));
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

const DEFAULT_SETTINGS = { autoStart: false };

function getSettings(): Record<string, any> {
  try {
    if (existsSync(config.settingsFile)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(config.settingsFile, "utf-8")) };
    }
  } catch { /* corrupt file — use defaults */ }
  return { ...DEFAULT_SETTINGS };
}

function apiGetSettings(res: ServerResponse): void {
  json(res, 200, getSettings());
}

function apiUpdateSettings(res: ServerResponse, body: any): void {
  const current = getSettings();
  const updated = { ...current, ...body };
  mkdirSync(config.tmpDir, { recursive: true });
  writeFileSync(config.settingsFile, JSON.stringify(updated, null, 2));
  json(res, 200, updated);
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

function apiClearLogs(res: ServerResponse): void {
  try {
    if (existsSync(config.logFile)) {
      truncateSync(config.logFile, 0);
    }
    json(res, 200, { ok: true });
  } catch (error: any) {
    json(res, 500, { error: error.message });
  }
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

function apiRepos(res: ServerResponse, url?: URL): void {
  const stack = url?.searchParams.get("stack");
  if (!stack) {
    json(res, 400, { error: "Missing 'stack' query parameter" });
    return;
  }
  const reposDir = config.stackReposDir(stack);
  const repoNames = discoverRepos(reposDir);
  const repos = repoNames
    .filter((name) => existsSync(join(reposDir, name, ".git")))
    .map((name) => {
      const repoPath = join(reposDir, name);
      const branch = defaultBranchFor(repoPath);
      return { name, defaultBranch: branch };
    });

  json(res, 200, repos);
}

function apiPodExists(res: ServerResponse, name: string): void {
  json(res, 200, { exists: podExists(name) });
}

async function apiCreatePod(res: ServerResponse, body: any): Promise<void> {
  const { name, repos, from, stack } = body;

  if (!name || typeof name !== "string" || !name.trim()) {
    json(res, 400, { error: "Pod name is required" });
    return;
  }

  if (!stack || typeof stack !== "string") {
    json(res, 400, { error: "Stack is required" });
    return;
  }

  try {
    validatePodName(name);
  } catch (err: any) {
    json(res, 400, { error: err.message });
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
      stack,
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

async function apiCreateSnapshot(res: ServerResponse, body: any): Promise<void> {
  const pod = typeof body?.pod === "string" ? body.pod.trim() : "";
  const snapshot = typeof body?.snapshot === "string" ? body.snapshot.trim() : "";

  if (!pod) {
    json(res, 400, { error: "Pod name is required" });
    return;
  }
  if (!snapshot) {
    json(res, 400, { error: "Snapshot name is required" });
    return;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(snapshot)) {
    json(res, 400, { error: "Snapshot name must start with alphanumeric and contain only letters, numbers, dashes, and underscores" });
    return;
  }

  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  try {
    dbSave(pod, snapshot, (msg) =>
      res.write(JSON.stringify({ type: "log", message: msg }) + "\n"),
    );
    res.write(JSON.stringify({ type: "done" }) + "\n");
  } catch (error: any) {
    res.write(JSON.stringify({ type: "error", message: error.message }) + "\n");
  }
  res.end();
}

function apiStacks(res: ServerResponse): void {
  const stacks = config.listStacks();
  json(res, 200, stacks);
}

function apiCache(res: ServerResponse, url?: URL): void {
  const stack = url?.searchParams.get("stack");
  if (!stack) {
    json(res, 400, { error: "Missing 'stack' query parameter" });
    return;
  }
  const cache = cacheList(stack);
  json(res, 200, cache);
}

function apiCacheDelete(res: ServerResponse, body: any): void {
  if (!body.layer) {
    json(res, 400, { error: "Missing 'layer'" });
    return;
  }
  if (!body.stack) {
    json(res, 400, { error: "Missing 'stack'" });
    return;
  }
  try {
    const logs: string[] = [];
    cacheDelete(body.layer, (msg) => logs.push(msg), body.stack);
    json(res, 200, { ok: true, logs });
  } catch (error: any) {
    json(res, 400, { error: error.message });
  }
}

function apiCacheDestroy(res: ServerResponse, body?: any): void {
  if (!body?.stack) {
    json(res, 400, { error: "Missing 'stack'" });
    return;
  }
  try {
    const logs: string[] = [];
    cacheDestroy((msg) => logs.push(msg), body.stack);
    json(res, 200, { ok: true, logs });
  } catch (error: any) {
    json(res, 500, { error: error.message });
  }
}

function apiStacksDetail(res: ServerResponse): void {
  const stacks = config.listStacks();
  const details = stacks.map((name) => {
    const imageName = config.imageFor(name);
    let image: { exists: boolean; name: string; sizeMB?: number; created?: string } = {
      exists: false,
      name: imageName,
    };
    try {
      const sizeStr = execSync(
        `docker image inspect "${imageName}" --format "{{.Size}}"`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim();
      const createdStr = execSync(
        `docker image inspect "${imageName}" --format "{{.Created}}"`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim();
      image = {
        exists: true,
        name: imageName,
        sizeMB: Math.round(parseInt(sizeStr, 10) / 1024 / 1024),
        created: createdStr.split("T")[0],
      };
    } catch { /* image doesn't exist */ }
    return { name, image };
  });
  json(res, 200, details);
}

async function apiStackBuild(res: ServerResponse, stackName: string): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  try {
    await buildAll(
      (msg) => res.write(JSON.stringify({ type: "log", message: msg }) + "\n"),
      stackName,
    );
    res.write(JSON.stringify({ type: "done" }) + "\n");
  } catch (error: any) {
    const msg = error.stderr?.toString().trim() || error.message;
    res.write(JSON.stringify({ type: "error", message: msg }) + "\n");
  }
  res.end();
}

async function apiPodUp(res: ServerResponse, podName: string): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  try {
    await podUp(podName, {
      onLog: (msg) => res.write(JSON.stringify({ type: "log", message: msg }) + "\n"),
      waitForServices: false,
    });
    res.write(JSON.stringify({ type: "done" }) + "\n");
  } catch (error: any) {
    res.write(JSON.stringify({ type: "error", message: error.message }) + "\n");
  }
  res.end();
}

function apiPodDown(res: ServerResponse, podName: string): void {
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  try {
    podDown(podName, (msg) => {
      res.write(JSON.stringify({ type: "log", message: msg }) + "\n");
    });
    res.write(JSON.stringify({ type: "done" }) + "\n");
  } catch (error: any) {
    res.write(JSON.stringify({ type: "error", message: error.message }) + "\n");
  }
  res.end();
}

function apiPodWarnings(res: ServerResponse, podName: string): void {
  try {
    const warnings = getRemoveWarnings(podName);
    json(res, 200, warnings);
  } catch (error: any) {
    json(res, 500, { error: error.message });
  }
}

function apiPodRemove(res: ServerResponse, podName: string): void {
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  try {
    removePod(podName, (msg) => {
      res.write(JSON.stringify({ type: "log", message: msg }) + "\n");
    });
    res.write(JSON.stringify({ type: "done" }) + "\n");
  } catch (error: any) {
    res.write(JSON.stringify({ type: "error", message: error.message }) + "\n");
  }
  res.end();
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
  const parsedUrl = new URL(req.url!, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);
  let filePath = resolve(root, pathname === "/" ? "index.html" : pathname.slice(1));

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

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
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
