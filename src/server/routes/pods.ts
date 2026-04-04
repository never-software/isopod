import { Hono } from "hono";
import {
  listPods,
  getPod,
  podExists,
  listRepos,
  downPod,
  removePod,
  execInPod,
  createPod,
  upPod,
} from "../../core/pods.js";
import { streamOperationEvents } from "../sse.js";

export const podRoutes = new Hono();

// GET /api/pods — list all pods
podRoutes.get("/", (c) => {
  return c.json(listPods());
});

// GET /api/pods/:name — get a single pod
podRoutes.get("/:name", (c) => {
  const name = c.req.param("name");
  const pod = getPod(name);
  if (!pod) {
    return c.json({ error: `Pod '${name}' not found` }, 404);
  }
  return c.json(pod);
});

// GET /api/pods/:name/exists — check if pod exists
podRoutes.get("/:name/exists", (c) => {
  const name = c.req.param("name");
  return c.json({ exists: podExists(name) });
});

// POST /api/pods — create a new pod (SSE stream)
podRoutes.post("/", async (c) => {
  const body = await c.req.json<{
    name: string;
    repos?: string[];
    from?: string;
    cloneDb?: boolean;
  }>();

  if (!body.name?.trim()) {
    return c.json({ error: "Pod name is required" }, 400);
  }

  return streamOperationEvents(c, createPod(body));
});

// POST /api/pods/:name/up — start/refresh a pod (SSE stream)
podRoutes.post("/:name/up", (c) => {
  const name = c.req.param("name");
  return streamOperationEvents(c, upPod(name));
});

// POST /api/pods/:name/down — stop a pod
podRoutes.post("/:name/down", (c) => {
  const name = c.req.param("name");
  try {
    downPod(name);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// DELETE /api/pods/:name — remove a pod
podRoutes.delete("/:name", (c) => {
  const name = c.req.param("name");
  const force = c.req.query("force") === "true";
  try {
    removePod(name, { force });
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/pods/:name/exec — execute command in pod
podRoutes.post("/:name/exec", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json<{ command: string[]; dir?: string }>();
  try {
    const result = execInPod(name, body.command, { dir: body.dir });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Repos endpoint (system-level but related to pod creation)
export const repoRoutes = new Hono();

repoRoutes.get("/", (c) => {
  return c.json(listRepos());
});
