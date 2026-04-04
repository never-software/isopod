import { Command } from "commander";
import { apiGet, apiPost, apiDelete } from "../client.js";
import { ensureServer } from "../daemon.js";
import {
  info,
  success,
  error as errorOut,
  header,
  colors,
  formatTable,
} from "../output.js";
import type { Snapshot } from "../../types.js";

export const dbCommand = new Command("db")
  .description("Manage database snapshots")
  .action(() => {
    dbCommand.outputHelp();
  });

dbCommand
  .command("save")
  .description("Save current DB state as a named snapshot")
  .argument("<pod>", "Pod name")
  .argument("<name>", "Snapshot name")
  .action(async (pod: string, name: string) => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    header(`Saving database snapshot: ${name}`);
    try {
      await apiPost("/api/db/snapshots", { pod, name });
      success(`Snapshot '${name}' saved from '${pod}'`);
    } catch (err: any) {
      errorOut(err.message);
      process.exit(1);
    }
  });

dbCommand
  .command("restore")
  .description("Restore a snapshot to a pod")
  .argument("<pod>", "Pod name")
  .argument("<name>", "Snapshot name")
  .action(async (pod: string, name: string) => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    header(`Restoring database snapshot: ${name} → ${pod}`);
    try {
      await apiPost(`/api/db/snapshots/${encodeURIComponent(name)}/restore`, {
        pod,
      });
      success(`Snapshot '${name}' restored to '${pod}'`);
    } catch (err: any) {
      errorOut(err.message);
      process.exit(1);
    }
  });

dbCommand
  .command("list")
  .alias("ls")
  .description("List all snapshots")
  .action(async () => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    const snapshots = await apiGet<Snapshot[]>("/api/db/snapshots");

    if (snapshots.length === 0) {
      console.log();
      console.log("  No snapshots found.");
      console.log(
        "  Create one with: isopod db save <feature-name> <snapshot-name>",
      );
      console.log();
      return;
    }

    header("Database snapshots");
    formatTable(
      ["NAME", "CREATED"],
      snapshots.map((s) => [s.name, s.created]),
      [30, 20],
    );
    console.log();
  });

dbCommand
  .command("delete")
  .alias("rm")
  .description("Delete a snapshot")
  .argument("<name>", "Snapshot name")
  .action(async (name: string) => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    try {
      await apiDelete(`/api/db/snapshots/${encodeURIComponent(name)}`);
      success(`Snapshot '${name}' deleted`);
    } catch (err: any) {
      errorOut(err.message);
      process.exit(1);
    }
  });
