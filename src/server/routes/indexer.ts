import { Hono } from "hono";
import { config } from "../../config.js";
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";

export const indexerRoutes = new Hono();

// Lazy-load indexer modules — they have heavy deps that may not be installed
let indexerModules: {
  getStatus: () => Promise<any>;
  deleteCollection: (name: string) => Promise<void>;
  deleteBranch: (name: string, branch: string) => Promise<void>;
  getCollectionBranches: (name: string) => Promise<any>;
  getAllBranches: () => Promise<any>;
  discoverWatchTargets: () => any[];
  startDaemon: () => Promise<void>;
  stopDaemon: () => void;
  getDisabledTargets: () => Set<string>;
  toggleTarget: (collectionName: string, branch: string) => boolean;
  setDisabledTargets: (disabled: Set<string>) => void;
  targetKey: (t: any) => string;
  indexerConfig: any;
} | null = null;

async function loadIndexer() {
  if (indexerModules) return indexerModules;

  try {
    const indexerRoot = resolve(config.isopodRoot, "indexer");
    const qdrantMod = await import(
      resolve(indexerRoot, "dist", "qdrant.js")
    );
    const watcherMod = await import(
      resolve(indexerRoot, "dist", "watcher.js")
    );
    const configMod = await import(
      resolve(indexerRoot, "dist", "config.js")
    );

    indexerModules = {
      getStatus: qdrantMod.getStatus,
      deleteCollection: qdrantMod.deleteCollection,
      deleteBranch: qdrantMod.deleteBranch,
      getCollectionBranches: qdrantMod.getCollectionBranches,
      getAllBranches: qdrantMod.getAllBranches,
      discoverWatchTargets: watcherMod.discoverWatchTargets,
      startDaemon: watcherMod.startDaemon,
      stopDaemon: watcherMod.stopDaemon,
      getDisabledTargets: watcherMod.getDisabledTargets,
      toggleTarget: watcherMod.toggleTarget,
      setDisabledTargets: watcherMod.setDisabledTargets,
      targetKey: watcherMod.targetKey,
      indexerConfig: configMod.config,
    };
    return indexerModules;
  } catch {
    return null;
  }
}

function notAvailable(c: any) {
  return c.json(
    { error: "Indexer not available. Install indexer dependencies first." },
    501,
  );
}

// GET /api/indexer/collections
indexerRoutes.get("/collections", async (c) => {
  const mod = await loadIndexer();
  if (!mod) return notAvailable(c);
  try {
    const status = await mod.getStatus();
    return c.json(status);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/indexer/branches
indexerRoutes.get("/branches", async (c) => {
  const mod = await loadIndexer();
  if (!mod) return notAvailable(c);
  try {
    const branches = await mod.getAllBranches();
    return c.json(branches);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/indexer/collection/:name/branches
indexerRoutes.get("/collection/:name/branches", async (c) => {
  const mod = await loadIndexer();
  if (!mod) return notAvailable(c);
  const name = c.req.param("name");
  try {
    const branches = await mod.getCollectionBranches(name);
    return c.json(branches);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/indexer/daemon
indexerRoutes.get("/daemon", async (c) => {
  const mod = await loadIndexer();
  if (!mod) return notAvailable(c);

  const pidFile = mod.indexerConfig.pidFile;
  if (!existsSync(pidFile)) {
    return c.json({ running: false, pid: null });
  }

  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    return c.json({ running: true, pid });
  } catch {
    return c.json({ running: false, pid: null });
  }
});

// POST /api/indexer/daemon/start
indexerRoutes.post("/daemon/start", async (c) => {
  const mod = await loadIndexer();
  if (!mod) return notAvailable(c);
  try {
    await mod.startDaemon();
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/indexer/daemon/stop
indexerRoutes.post("/daemon/stop", async (c) => {
  const mod = await loadIndexer();
  if (!mod) return notAvailable(c);
  try {
    mod.stopDaemon();
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/indexer/logs
indexerRoutes.get("/logs", async (c) => {
  const mod = await loadIndexer();
  if (!mod) return notAvailable(c);

  const n = parseInt(c.req.query("n") || "100", 10);
  const logFile = mod.indexerConfig.logFile;

  if (!existsSync(logFile)) {
    return c.json({ lines: [] });
  }

  const lines = tailFile(logFile, n);
  return c.json({ lines });
});

// GET /api/indexer/watch-targets
indexerRoutes.get("/watch-targets", async (c) => {
  const mod = await loadIndexer();
  if (!mod) return notAvailable(c);

  const targets = mod.discoverWatchTargets();
  const disabled = mod.getDisabledTargets();
  const enriched = targets.map((t: any) => ({
    ...t,
    enabled: !disabled.has(mod.targetKey(t)),
  }));
  return c.json(enriched);
});

// POST /api/indexer/watch-targets/toggle
indexerRoutes.post("/watch-targets/toggle", async (c) => {
  const mod = await loadIndexer();
  if (!mod) return notAvailable(c);

  const body = await c.req.json<{
    collectionName?: string;
    branch?: string;
    podName?: string;
    enabled?: boolean;
  }>();

  // Toggle a specific target
  if (body.collectionName && body.branch) {
    const enabled = mod.toggleTarget(body.collectionName, body.branch);
    return c.json({ collectionName: body.collectionName, branch: body.branch, enabled });
  }

  // Toggle all targets for a pod
  if (body.podName !== undefined && body.enabled !== undefined) {
    const targets = mod.discoverWatchTargets().filter(
      (t: any) => t.podName === body.podName,
    );
    const disabled = mod.getDisabledTargets();

    for (const t of targets) {
      const key = mod.targetKey(t);
      if (body.enabled) {
        disabled.delete(key);
      } else {
        disabled.add(key);
      }
    }
    mod.setDisabledTargets(disabled);
    return c.json({ podName: body.podName, enabled: body.enabled, toggled: targets.length });
  }

  return c.json({ error: "Missing required fields" }, 400);
});

// POST /api/indexer/collection/:name/delete
indexerRoutes.post("/collection/:name/delete", async (c) => {
  const mod = await loadIndexer();
  if (!mod) return notAvailable(c);
  const name = c.req.param("name");
  try {
    await mod.deleteCollection(name);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/indexer/collection/:name/delete-branch
indexerRoutes.post("/collection/:name/delete-branch", async (c) => {
  const mod = await loadIndexer();
  if (!mod) return notAvailable(c);
  const name = c.req.param("name");
  const body = await c.req.json<{ branch: string }>();
  if (!body.branch) {
    return c.json({ error: "Missing 'branch'" }, 400);
  }
  try {
    await mod.deleteBranch(name, body.branch);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/indexer/collections/delete-all
indexerRoutes.post("/collections/delete-all", async (c) => {
  const mod = await loadIndexer();
  if (!mod) return notAvailable(c);
  try {
    const status = await mod.getStatus();
    for (const col of status) {
      await mod.deleteCollection(col.name);
    }
    return c.json({ ok: true, deleted: status.length });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────

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
