import { Hono } from "hono";
import { listPods, getPod, podExists, listRepos } from "../../core/pods.js";

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

// Repos endpoint (system-level but related to pod creation)
export const repoRoutes = new Hono();

repoRoutes.get("/", (c) => {
  return c.json(listRepos());
});
