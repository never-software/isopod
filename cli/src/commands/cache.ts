import { Command } from "commander";
import { cacheList, cacheRebuild, cacheDelete, cacheDestroy } from "isopod-api";
import { info, success, error, header, bold, dim, green, yellow } from "../output.js";

export const cacheCommand = new Command("cache")
  .description("Manage build cache")
  .addCommand(
    new Command("list")
      .alias("ls")
      .description("Show all layers and their status")
      .action(() => {
        try {
          const cache = cacheList();

          header("Cache layers");

          if (cache.layers.length === 0) {
            console.log(`  ${dim("No layers found (no workspace.Dockerfile or no # layer: markers)")}`);
            console.log();
            return;
          }

          console.log(`  ${bold("#".padEnd(4))} ${bold("LAYER".padEnd(16))} ${bold("VERSION".padEnd(14))} ${bold("STATUS")}`);
          cache.layers.forEach((layer, idx) => {
            let statusDisplay: string = layer.status;
            let color = green;
            if (layer.status === "stale") {
              statusDisplay = `stale (was ${layer.storedVersion})`;
              color = yellow;
            } else if (layer.status === "not built") {
              color = dim;
            }
            console.log(`  ${String(idx + 1).padEnd(4)} ${layer.name.padEnd(16)} ${layer.version.padEnd(14)} ${color(statusDisplay)}`);
          });
          console.log();

          if (cache.image.exists) {
            console.log(`  ${bold("Image:")} ${cache.image.name} (${cache.image.sizeMB}MB, built ${cache.image.created})`);
          } else {
            console.log(`  ${bold("Image:")} not built`);
          }
          console.log();
        } catch (err: any) {
          error(err.message);
        }
      })
  )
  .addCommand(
    new Command("rebuild")
      .description("Rebuild from a layer (cascades to later layers)")
      .argument("<layer>", "Layer name")
      .action((layer: string) => {
        try {
          cacheRebuild(layer, (msg) => info(msg));
        } catch (err: any) {
          error(err.message);
        }
      })
  )
  .addCommand(
    new Command("delete")
      .description("Mark a layer as stale")
      .argument("<layer>", "Layer name")
      .action((layer: string) => {
        try {
          cacheDelete(layer, (msg) => info(msg));
        } catch (err: any) {
          error(err.message);
        }
      })
  )
  .addCommand(
    new Command("destroy")
      .description("Remove workspace image and all cached hashes")
      .action(() => {
        try {
          cacheDestroy((msg) => info(msg));
        } catch (err: any) {
          error(err.message);
        }
      })
  );
