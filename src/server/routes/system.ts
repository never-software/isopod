import { Hono } from "hono";
import { getLayerInfos } from "../../core/layers.js";
import { nuke, freshDbSeed } from "../../core/system.js";
import { streamOperationEvents } from "../sse.js";
import { config } from "../../config.js";
import { execSync } from "child_process";

export const systemRoutes = new Hono();

// GET /api/system/info — system overview (cache/image info)
systemRoutes.get("/info", (c) => {
  const layers = getLayerInfos();
  let imageInfo: { exists: boolean; name: string; sizeMb?: number; created?: string } = {
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
      imageInfo = {
        exists: true,
        name: config.workspaceImage,
        sizeMb: Math.round(parseInt(size || "0", 10) / 1024 / 1024),
        created: (created || "").split("T")[0],
      };
    }
  } catch {
    // Image doesn't exist
  }

  return c.json({ layers, image: imageInfo });
});

// POST /api/system/nuke — nuke all Docker resources (SSE)
systemRoutes.post("/nuke", (c) => {
  return streamOperationEvents(c, nuke());
});

// POST /api/fresh-db-seed — build + seed (SSE)
systemRoutes.post("/fresh-db-seed", (c) => {
  return streamOperationEvents(c, freshDbSeed());
});
