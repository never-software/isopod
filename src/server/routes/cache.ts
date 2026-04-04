import { Hono } from "hono";
import { getLayerInfos } from "../../core/layers.js";
import { cacheRebuild, cacheDelete, cacheDestroy } from "../../core/cache.js";
import { buildAll } from "../../core/docker.js";
import { streamOperationEvents } from "../sse.js";
import { config } from "../../config.js";
import { execSync } from "child_process";

export const cacheRoutes = new Hono();

// GET /api/cache — cache info (layers + image)
cacheRoutes.get("/", (c) => {
  const layers = getLayerInfos();
  let image: { exists: boolean; name: string; sizeMb?: number; created?: string } = {
    exists: false,
    name: config.workspaceImage,
  };

  try {
    const output = execSync(
      `docker image inspect ${config.workspaceImage} --format "{{.Size}}\t{{.Created}}"`,
      { encoding: "utf-8", timeout: 10000 },
    ).trim();
    if (output) {
      const [size, created] = output.split("\t");
      image = {
        exists: true,
        name: config.workspaceImage,
        sizeMb: Math.round(parseInt(size || "0", 10) / 1024 / 1024),
        created: (created || "").split("T")[0],
      };
    }
  } catch {
    // image doesn't exist
  }

  return c.json({ layers, image });
});

// POST /api/cache/rebuild — rebuild from a layer (SSE)
cacheRoutes.post("/rebuild", async (c) => {
  const body = await c.req.json<{ layer: string }>();
  if (!body.layer) {
    return c.json({ error: "Missing 'layer'" }, 400);
  }
  return streamOperationEvents(c, cacheRebuild(body.layer));
});

// DELETE /api/cache/:layer — mark a layer as stale
cacheRoutes.delete("/:layer", (c) => {
  const layer = c.req.param("layer");
  try {
    cacheDelete(layer);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// DELETE /api/cache — destroy all cache
cacheRoutes.delete("/", (c) => {
  return streamOperationEvents(c, cacheDestroy());
});

// POST /api/build — full build (SSE)
cacheRoutes.post("/build", (c) => {
  return streamOperationEvents(c, buildAll());
});
