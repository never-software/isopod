import { Command } from "commander";
import { loadSharingManifest, writeSharingManifest, sharingManifestPath } from "isopod-api";
import type { SharingManifest, SharingMode } from "isopod-api";
import { success, error, header, bold, dim } from "../output.js";

// The manifest marks each pod_workspace_template entry "shared" (a live bind
// mount of the stack's canonical template — edits flow back and across pods) or
// "local" (the default: a per-pod copy whose edits stay in that pod). Changes
// apply to each pod on its next `isopod up`.

function parseMode(value: string): SharingMode {
  if (value !== "shared" && value !== "local") {
    error(`Mode must be 'shared' or 'local' (got '${value}')`);
  }
  return value as SharingMode;
}

function printManifest(stack: string, m: SharingManifest): void {
  header(`Workspace sharing — ${stack}`);
  console.log(`  ${bold("default")}: ${m.default}`);
  console.log(`  ${dim(sharingManifestPath(stack))}`);
  const keys = Object.keys(m.overrides).sort();
  if (keys.length === 0) {
    console.log(`  ${dim(`(no overrides — every entry is '${m.default}')`)}`);
  } else {
    console.log("  overrides:");
    for (const k of keys) {
      console.log(`    ${m.overrides[k].padEnd(7)} ${k}`);
    }
  }
  console.log();
}

export const sharingCommand = new Command("sharing")
  .description("Mark workspace entries shared (live, cross-pod) or local (per-pod copy)")
  .addCommand(
    new Command("list")
      .alias("ls")
      .description("Show the sharing manifest for a stack")
      .requiredOption("--stack <name>", "Stack to inspect")
      .action((opts: { stack: string }) => {
        printManifest(opts.stack, loadSharingManifest(opts.stack));
      }),
  )
  .addCommand(
    new Command("set")
      .description("Mark a path 'shared' or 'local'")
      .argument("<path>", "Workspace-relative path, e.g. .claude/skills")
      .argument("<mode>", "shared | local")
      .requiredOption("--stack <name>", "Stack to target")
      .action((path: string, mode: string, opts: { stack: string }) => {
        const resolved = parseMode(mode);
        const m = loadSharingManifest(opts.stack);
        m.overrides[path] = resolved;
        writeSharingManifest(opts.stack, m);
        success(`${opts.stack}: ${path} → ${resolved}`);
      }),
  )
  .addCommand(
    new Command("unset")
      .alias("rm")
      .description("Remove a path's override (it inherits its parent / the default again)")
      .argument("<path>", "Workspace-relative path")
      .requiredOption("--stack <name>", "Stack to target")
      .action((path: string, opts: { stack: string }) => {
        const m = loadSharingManifest(opts.stack);
        if (!(path in m.overrides)) {
          error(`${opts.stack}: no override for '${path}'`);
        }
        delete m.overrides[path];
        writeSharingManifest(opts.stack, m);
        success(`${opts.stack}: removed override for ${path}`);
      }),
  )
  .addCommand(
    new Command("default")
      .description("Set the default mode for entries with no override")
      .argument("<mode>", "shared | local")
      .requiredOption("--stack <name>", "Stack to target")
      .action((mode: string, opts: { stack: string }) => {
        const resolved = parseMode(mode);
        const m = loadSharingManifest(opts.stack);
        m.default = resolved;
        writeSharingManifest(opts.stack, m);
        success(`${opts.stack}: default → ${resolved}`);
      }),
  );
