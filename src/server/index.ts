import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { resolve, join, extname } from "path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { config } from "../config.js";
import { podRoutes, repoRoutes } from "./routes/pods.js";
import { systemRoutes } from "./routes/system.js";

export const app = new Hono();

// CORS for browser clients
app.use("/api/*", cors());

// Health check
app.get("/health", (c) => {
  return c.json({ ok: true, pid: process.pid });
});

// API routes
app.route("/api/pods", podRoutes);
app.route("/api/repos", repoRoutes);
app.route("/api/system", systemRoutes);

// Static file serving for SolidJS dashboard
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

app.get("/*", (c) => {
  const dashboardDir = config.dashboardDir;
  const urlPath = new URL(c.req.url).pathname;
  let filePath = join(dashboardDir, urlPath === "/" ? "index.html" : urlPath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(dashboardDir)) {
    return c.text("Forbidden", 403);
  }

  // Try exact file first
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback — serve index.html
    filePath = join(dashboardDir, "index.html");
    if (!existsSync(filePath)) {
      return c.text("Dashboard not built. Run: cd ui && npm run build", 404);
    }
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = readFileSync(filePath);

  return new Response(content, {
    headers: { "Content-Type": contentType },
  });
});

export function startServer(port?: number): void {
  const p = port ?? config.port;

  serve({ fetch: app.fetch, port: p }, (info) => {
    console.log(`Isopod server running at http://localhost:${info.port}`);
    console.log(`PID: ${process.pid}`);
  });

  const shutdown = () => {
    console.log("\nShutting down...");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// When run directly: start the server
const isDirectRun =
  process.argv[1]?.endsWith("server/index.js") ||
  process.argv[1]?.endsWith("server/index.ts");

if (isDirectRun) {
  startServer();
}
