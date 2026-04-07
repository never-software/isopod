import { Command } from "commander";
import { dbSave, dbRestore, dbList, dbDelete } from "isopod-api";
import { info, success, error, header, bold, dim } from "../output.js";

export const dbCommand = new Command("db")
  .description("Manage database snapshots")
  .addCommand(
    new Command("save")
      .description("Save current DB state as a named snapshot")
      .argument("<feature-name>", "Pod name")
      .argument("<snapshot-name>", "Snapshot name")
      .action((feature: string, snapshot: string) => {
        try {
          dbSave(feature, snapshot, (msg) => info(msg));
        } catch (err: any) {
          error(err.message);
        }
      })
  )
  .addCommand(
    new Command("restore")
      .description("Restore a snapshot to a pod")
      .argument("<feature-name>", "Pod name")
      .argument("<snapshot-name>", "Snapshot name")
      .action((feature: string, snapshot: string) => {
        try {
          dbRestore(feature, snapshot, (msg) => info(msg));
        } catch (err: any) {
          error(err.message);
        }
      })
  )
  .addCommand(
    new Command("list")
      .alias("ls")
      .description("List all snapshots")
      .action(() => {
        try {
          const snapshots = dbList();

          if (snapshots.length === 0) {
            console.log();
            console.log("  No snapshots found.");
            console.log("  Create one with: isopod db save <feature-name> <snapshot-name>");
            console.log();
            return;
          }

          header("Database snapshots");
          console.log(`  ${bold("NAME".padEnd(30))}  ${bold("CREATED".padEnd(20))}`);
          for (const snap of snapshots) {
            console.log(`  ${snap.name.padEnd(30)}  ${snap.created.padEnd(20)}`);
          }
          console.log();
        } catch (err: any) {
          error(err.message);
        }
      })
  )
  .addCommand(
    new Command("delete")
      .alias("rm")
      .description("Delete a snapshot")
      .argument("<snapshot-name>", "Snapshot name")
      .action((snapshot: string) => {
        try {
          dbDelete(snapshot, (msg) => info(msg));
        } catch (err: any) {
          error(err.message);
        }
      })
  );
