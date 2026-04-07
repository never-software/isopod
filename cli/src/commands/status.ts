import { Command } from "commander";
import { podStatus, requireDocker } from "isopod-api";
import { header, error } from "../output.js";

export const statusCommand = new Command("status")
  .description("Show container health")
  .argument("[feature-name]", "Pod name (optional)")
  .action((featureName?: string) => {
    try {
      requireDocker();
      header(featureName ? `${featureName} (container)` : "Pod container status");
      console.log(podStatus(featureName));
    } catch (err: any) {
      error(err.message);
    }
  });
