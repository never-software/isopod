import { Command } from "commander";
import {
  loadManifest,
  writeManifest,
  manifestPath,
  workspaceScope,
  homeScope,
} from "isopod-api";
import type { SharingManifest, SharingMode, SharingScope } from "isopod-api";
import { success, error, header, bold, dim } from "../output.js";

// A manifest marks each entry of a scope's source "shared" (a live bind mount of
// the stack's canonical source — edits flow back and across pods) or "local"
// (the default; per-pod). Two scopes share this command builder:
//   workspace — stacks/<stack>/workspace → /workspace
//   home      — stacks/<stack>/home       → /home/dev (e.g. share ~/.claude so a
//               Claude login persists across every pod)
// Changes apply to each pod on its next `isopod up`.

function parseMode(value: string): SharingMode {
  if (value !== "shared" && value !== "local") {
    error(`Mode must be 'shared' or 'local' (got '${value}')`);
  }
  return value as SharingMode;
}

interface ScopeMeta {
  command: string;       // CLI command name
  title: string;         // header label
  pathExample: string;   // example path in --help
  scopeOf: (stack: string) => SharingScope;
}

function printManifest(meta: ScopeMeta, stack: string, m: SharingManifest): void {
  header(`${meta.title} — ${stack}`);
  console.log(`  ${bold("default")}: ${m.default}`);
  console.log(`  ${dim(manifestPath(meta.scopeOf(stack), stack))}`);
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

function makeSharingCommand(meta: ScopeMeta): Command {
  const load = (stack: string) => loadManifest(meta.scopeOf(stack), stack);
  const write = (stack: string, m: SharingManifest) => writeManifest(meta.scopeOf(stack), stack, m);

  return new Command(meta.command)
    .description(`Mark ${meta.title.toLowerCase()} entries shared (live, cross-pod) or local (per-pod copy)`)
    .addCommand(
      new Command("list")
        .alias("ls")
        .description("Show the sharing manifest for a stack")
        .requiredOption("--stack <name>", "Stack to inspect")
        .action((opts: { stack: string }) => {
          printManifest(meta, opts.stack, load(opts.stack));
        }),
    )
    .addCommand(
      new Command("set")
        .description("Mark a path 'shared' or 'local'")
        .argument("<path>", `Relative path, e.g. ${meta.pathExample}`)
        .argument("<mode>", "shared | local")
        .requiredOption("--stack <name>", "Stack to target")
        .action((path: string, mode: string, opts: { stack: string }) => {
          const resolved = parseMode(mode);
          const m = load(opts.stack);
          m.overrides[path] = resolved;
          write(opts.stack, m);
          success(`${opts.stack}: ${path} → ${resolved}`);
        }),
    )
    .addCommand(
      new Command("unset")
        .alias("rm")
        .description("Remove a path's override (it inherits its parent / the default again)")
        .argument("<path>", "Relative path")
        .requiredOption("--stack <name>", "Stack to target")
        .action((path: string, opts: { stack: string }) => {
          const m = load(opts.stack);
          if (!(path in m.overrides)) {
            error(`${opts.stack}: no override for '${path}'`);
          }
          delete m.overrides[path];
          write(opts.stack, m);
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
          const m = load(opts.stack);
          m.default = resolved;
          write(opts.stack, m);
          success(`${opts.stack}: default → ${resolved}`);
        }),
    );
}

export const sharingCommand = makeSharingCommand({
  command: "sharing",
  title: "Workspace sharing",
  pathExample: ".claude/skills",
  scopeOf: workspaceScope,
});

export const homeSharingCommand = makeSharingCommand({
  command: "home-sharing",
  title: "Home sharing",
  pathExample: ".claude",
  scopeOf: homeScope,
});
