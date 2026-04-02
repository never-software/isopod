#!/usr/bin/env node

import { Command } from "commander";
import { config } from "./config.js";
import { indexBase, indexPod, deletePodsCollections } from "./indexer.js";
import { search, getStatus } from "./qdrant.js";
import { startDaemon, stopDaemon, daemonStatus, startWatcher } from "./watcher.js";

const program = new Command();

program
  .name("isopod-indexer")
  .description("Code indexing for isopod workspaces")
  .version("1.0.0");

program
  .command("index-base")
  .description("Full-index base repos")
  .argument("[repo]", "Specific repo to index (default: all)")
  .action(async (repo?: string) => {
    await indexBase(repo);
  });

program
  .command("index-pod")
  .description("Delta-index a pod's changed files")
  .argument("<pod>", "Pod name")
  .action(async (pod: string) => {
    await indexPod(pod);
  });

program
  .command("delete-pod")
  .description("Delete all collections for a pod")
  .argument("<pod>", "Pod name")
  .action(async (pod: string) => {
    await deletePodsCollections(pod);
  });

program
  .command("search")
  .description("Search indexed code")
  .argument("<query>", "Search query")
  .option("--pod <name>", "Search within a pod (overlays on base)")
  .option("--repo <name>", "Limit to a specific repo")
  .option("-n, --limit <number>", "Number of results", "10")
  .action(async (query: string, opts: { pod?: string; repo?: string; limit: string }) => {
    const results = await search(query, {
      pod: opts.pod,
      repo: opts.repo,
      limit: parseInt(opts.limit, 10),
    });

    if (results.length === 0) {
      console.log("No results found.");
      return;
    }

    for (const result of results) {
      const p = result.payload;
      const score = result.score.toFixed(3);
      console.log(`\n\x1b[36m${p.file_path}\x1b[0m:\x1b[33m${p.line_start}-${p.line_end}\x1b[0m \x1b[2m(${score})\x1b[0m`);
      if (p.symbol_name) {
        console.log(`  \x1b[1m${p.symbol_name}\x1b[0m  \x1b[2m[${p.chunk_type}]\x1b[0m`);
      }
      // Show first 3 lines of content as preview
      const preview = p.content.split("\n").slice(0, 3).join("\n");
      console.log(`  \x1b[2m${preview}\x1b[0m`);
    }
    console.log(`\n${results.length} results`);
  });

program
  .command("daemon")
  .description("Manage the file watcher daemon")
  .argument("<action>", "start | stop | status")
  .action(async (action: string) => {
    switch (action) {
      case "start":
        await startDaemon();
        break;
      case "stop":
        stopDaemon();
        break;
      case "status":
        daemonStatus();
        break;
      default:
        console.error(`Unknown daemon action: ${action}. Use start|stop|status.`);
        process.exit(1);
    }
  });

program
  .command("status")
  .description("Show indexing status")
  .action(async () => {
    const status = await getStatus();
    console.log("\x1b[1mIsopod Indexer Status\x1b[0m\n");
    for (const col of status) {
      console.log(`  \x1b[36m${col.name}\x1b[0m: ${col.points} points`);
    }
    daemonStatus();
  });

// Internal command: the daemon forks itself with this
program
  .command("watch")
  .description("Start file watcher (internal — use 'daemon start' instead)")
  .action(async () => {
    await startWatcher();
  });

program.parse();
