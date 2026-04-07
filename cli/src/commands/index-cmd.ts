import { Command } from "commander";
import { indexBase, indexPod, deletePodBranch } from "isopod-api";
import { error } from "../output.js";

export const indexCommand = new Command("index")
  .description("Manage code indexing")
  .addCommand(
    new Command("index-base")
      .description("Full-index base repos")
      .argument("[repo]", "Specific repo to index (default: all)")
      .action(async (repo?: string) => {
        try {
          await indexBase(repo);
        } catch (err: any) {
          error(err.message);
        }
      })
  )
  .addCommand(
    new Command("index-pod")
      .description("Delta-index a pod's changed files")
      .argument("<pod>", "Pod name")
      .action(async (pod: string) => {
        try {
          await indexPod(pod);
        } catch (err: any) {
          error(err.message);
        }
      })
  )
  .addCommand(
    new Command("delete-pod")
      .description("Delete all index data for a pod")
      .argument("<pod>", "Pod name")
      .action(async (pod: string) => {
        try {
          await deletePodBranch(pod);
        } catch (err: any) {
          error(err.message);
        }
      })
  );
