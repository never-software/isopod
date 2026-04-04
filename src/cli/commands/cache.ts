import { Command } from "commander";
import { apiGet, apiPost, apiDelete, apiStream } from "../client.js";
import { ensureServer } from "../daemon.js";
import {
  success,
  error as errorOut,
  header,
  colors,
  formatTable,
  printEvent,
} from "../output.js";
import type { CacheInfo, LayerInfo } from "../../types.js";

export const cacheCommand = new Command("cache")
  .description("Manage build cache")
  .action(async () => {
    // Default: list
    await cacheListAction();
  });

cacheCommand
  .command("list")
  .alias("ls")
  .description("Show all layers and their status")
  .action(cacheListAction);

async function cacheListAction() {
  if (!(await ensureServer())) {
    errorOut("Could not connect to server");
    process.exit(1);
  }

  const data = await apiGet<{
    layers: LayerInfo[];
    image: CacheInfo["image"];
  }>("/api/cache");

  header("Cache layers");

  if (data.layers.length === 0) {
    console.log(
      colors.dim(
        "  No layers found (no workspace.Dockerfile or no # layer: markers)",
      ),
    );
    console.log();
    return;
  }

  const headers = ["#", "LAYER", "VERSION", "STATUS"];
  const rows = data.layers.map((l) => {
    let statusDisplay: string = l.status;
    if (l.status === "stale" && l.storedVersion) {
      statusDisplay = `stale (was ${l.storedVersion})`;
    }
    return [String(l.index), l.name, l.version, statusDisplay];
  });
  formatTable(headers, rows, [4, 16, 14, 30]);

  console.log();

  if (data.image.exists) {
    console.log(
      `  ${colors.bold("Image:")} ${data.image.name} (${data.image.sizeMb}MB, built ${data.image.created})`,
    );
  } else {
    console.log(`  ${colors.bold("Image:")} not built`);
  }
  console.log();
}

cacheCommand
  .command("rebuild")
  .description("Rebuild from a layer (cascades to later layers)")
  .argument("<layer>", "Layer name")
  .action(async (layer: string) => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    try {
      for await (const event of apiStream("/api/cache/rebuild", { layer })) {
        printEvent(event);
      }
    } catch (err: any) {
      errorOut(err.message);
      process.exit(1);
    }
  });

cacheCommand
  .command("delete")
  .description("Mark a layer as stale")
  .argument("<layer>", "Layer name")
  .action(async (layer: string) => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    try {
      await apiDelete(`/api/cache/${encodeURIComponent(layer)}`);
      success(
        `Stored hash for '${layer}' deleted. Next build will treat it as stale.`,
      );
    } catch (err: any) {
      errorOut(err.message);
      process.exit(1);
    }
  });

cacheCommand
  .command("destroy")
  .description("Remove workspace image and all cached hashes")
  .action(async () => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    try {
      // Use apiStream since cacheDestroy is a streaming endpoint (DELETE → SSE)
      // But our client.ts apiStream does POST. Let's use apiDelete for this.
      await apiDelete("/api/cache");
      success("Cache destroyed.");
    } catch (err: any) {
      errorOut(err.message);
      process.exit(1);
    }
  });
