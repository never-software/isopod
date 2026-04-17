import { Command } from "commander";
import { cacheList, cacheRebuild, cacheDelete, cacheDestroy } from "isopod-api";
import type { LayerInfo } from "isopod-api";
import { info, success, error, header, bold, dim, green, yellow } from "../output.js";

function formatStatus(layer: LayerInfo): { text: string; color: (s: string) => string } {
  if (layer.status === "stale") return { text: `stale (was ${layer.storedVersion})`, color: yellow };
  if (layer.status === "not built") return { text: layer.status, color: dim };
  return { text: layer.status, color: green };
}

function printLinearList(layers: LayerInfo[]): void {
  console.log(`  ${bold("#".padEnd(4))} ${bold("LAYER".padEnd(16))} ${bold("VERSION".padEnd(14))} ${bold("STATUS")}`);
  layers.forEach((layer, idx) => {
    const { text, color } = formatStatus(layer);
    console.log(`  ${String(idx + 1).padEnd(4)} ${layer.name.padEnd(16)} ${layer.version.padEnd(14)} ${color(text)}`);
  });
}

function printDAGTree(layers: LayerInfo[]): void {
  // Group children by their from parent
  const childrenOf = new Map<string | undefined, LayerInfo[]>();
  for (const layer of layers) {
    const parent = layer.from;
    const list = childrenOf.get(parent) || [];
    list.push(layer);
    childrenOf.set(parent, list);
  }

  console.log(`  ${bold("LAYER".padEnd(22))} ${bold("VERSION".padEnd(14))} ${bold("STATUS")}`);

  function printNode(layer: LayerInfo, prefix: string, connector: string): void {
    const { text, color } = formatStatus(layer);
    const label = `${connector}${layer.name}`;
    console.log(`  ${label.padEnd(22)} ${layer.version.padEnd(14)} ${color(text)}`);

    if (layer.needs && layer.needs.length > 0) {
      const indent = prefix + (connector ? "   " : "");
      console.log(`  ${indent}${dim(`needs: ${layer.needs.join(", ")}`)}`);
    }

    const children = childrenOf.get(layer.name) || [];
    children.forEach((child, i) => {
      const isLast = i === children.length - 1;
      const childConnector = isLast ? `${prefix}\u2514\u2500 ` : `${prefix}\u251C\u2500 `;
      const childPrefix = isLast ? `${prefix}   ` : `${prefix}\u2502  `;
      printNode(child, childPrefix, childConnector);
    });
  }

  // Start from root layers (no parent)
  const roots = childrenOf.get(undefined) || [];
  for (const root of roots) {
    printNode(root, "", "");
  }
}

export const cacheCommand = new Command("cache")
  .description("Manage build cache")
  .addCommand(
    new Command("list")
      .alias("ls")
      .description("Show all layers and their status")
      .requiredOption("--stack <name>", "Stack to inspect (default: docker.local)")
      .action((opts: { stack?: string }) => {
        try {
          const cache = cacheList(opts.stack);

          header("Cache layers");

          if (cache.layers.length === 0) {
            console.log(`  ${dim("No layers found (no workspace.Dockerfile or no # layer: markers)")}`);
            console.log();
            return;
          }

          if (cache.isDAG) {
            printDAGTree(cache.layers);
          } else {
            printLinearList(cache.layers);
          }
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
      .requiredOption("--stack <name>", "Stack to rebuild (default: docker.local)")
      .action(async (layer: string, opts: { stack?: string }) => {
        try {
          await cacheRebuild(layer, (msg) => info(msg), opts.stack);
        } catch (err: any) {
          error(err.message);
        }
      })
  )
  .addCommand(
    new Command("delete")
      .description("Mark a layer as stale")
      .argument("<layer>", "Layer name")
      .requiredOption("--stack <name>", "Stack to target (default: docker.local)")
      .action((layer: string, opts: { stack?: string }) => {
        try {
          cacheDelete(layer, (msg) => info(msg), opts.stack);
        } catch (err: any) {
          error(err.message);
        }
      })
  )
  .addCommand(
    new Command("destroy")
      .description("Remove workspace image and all cached hashes")
      .requiredOption("--stack <name>", "Stack to destroy (default: docker.local)")
      .action((opts: { stack?: string }) => {
        try {
          cacheDestroy((msg) => info(msg), opts.stack);
        } catch (err: any) {
          error(err.message);
        }
      })
  );
