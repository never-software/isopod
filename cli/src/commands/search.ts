import { Command } from "commander";
import { search } from "isopod-api";
import { error } from "../output.js";

export const searchCommand = new Command("search")
  .description("Search indexed code")
  .argument("<query>", "Search query")
  .option("--pod <name>", "Search within a pod (overlays on base)")
  .option("--repo <name>", "Limit to a specific repo")
  .option("-n, --limit <number>", "Number of results", "10")
  .action(async (query: string, opts: { pod?: string; repo?: string; limit: string }) => {
    try {
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
        const preview = p.content.split("\n").slice(0, 3).join("\n");
        console.log(`  \x1b[2m${preview}\x1b[0m`);
      }
      console.log(`\n${results.length} results`);
    } catch (err: any) {
      error(err.message);
    }
  });
