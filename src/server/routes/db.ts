import { Hono } from "hono";
import { dbList, dbSave, dbRestore, dbDelete } from "../../core/db.js";

export const dbRoutes = new Hono();

// GET /api/db/snapshots — list all snapshots
dbRoutes.get("/snapshots", (c) => {
  return c.json(dbList());
});

// POST /api/db/snapshots — save a snapshot
dbRoutes.post("/snapshots", async (c) => {
  const body = await c.req.json<{ pod: string; name: string }>();
  if (!body.pod || !body.name) {
    return c.json({ error: "Missing 'pod' or 'name'" }, 400);
  }
  try {
    dbSave(body.pod, body.name);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/db/snapshots/:name/restore — restore a snapshot
dbRoutes.post("/snapshots/:name/restore", async (c) => {
  const snapName = c.req.param("name");
  const body = await c.req.json<{ pod: string }>();
  if (!body.pod) {
    return c.json({ error: "Missing 'pod'" }, 400);
  }
  try {
    dbRestore(body.pod, snapName);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// DELETE /api/db/snapshots/:name — delete a snapshot
dbRoutes.delete("/snapshots/:name", (c) => {
  const snapName = c.req.param("name");
  try {
    dbDelete(snapName);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
