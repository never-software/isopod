import { Command } from "commander";
import {
  createOffloadPod,
  doctorOffload,
  execOffloadPod,
  expireOffloadLeases,
  handleOffloadPressure,
  offloadJsonError,
  offloadJsonOk,
  parseRepoRefOptions,
  removeOffloadPod,
  renewOffloadLease,
  statusOffloadPods,
  stopAllOffloadPods,
  stopOffloadPod,
  upOffloadPod,
  type OffloadOperation,
} from "isopod-api";
import { info, success } from "../output.js";

type JsonOption = { json?: boolean };

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function fail(operation: OffloadOperation, err: unknown, json?: boolean): never {
  const body = offloadJsonError(operation, err);
  if (json) {
    emitJson(body);
  } else {
    console.error(`${body.error.code}: ${body.error.message}`);
  }
  process.exit(1);
}

async function runCommand<T>(
  operation: OffloadOperation,
  json: boolean | undefined,
  action: () => Promise<T> | T,
  text: (result: T) => void,
): Promise<T> {
  try {
    const result = await action();
    if (json) emitJson(offloadJsonOk(operation, result));
    else text(result);
    return result;
  } catch (err) {
    fail(operation, err, json);
  }
}

export const offloadCommand = new Command("offload")
  .description("Manage source-only Offload pods");

offloadCommand
  .command("create")
  .description("Create a source-only Offload pod from remote Git refs")
  .argument("<stack>", "Stack name")
  .argument("<pod>", "Pod name")
  .option("--repo <name=url>", "Repo remote URL", collect, [])
  .option("--ref <name=refs/heads/branch>", "Repo ref to resolve", collect, [])
  .option("--json", "Emit stable machine-readable JSON")
  .action(async (stack: string, pod: string, opts: JsonOption & { repo: string[]; ref: string[] }) => {
    await runCommand(
      "create",
      opts.json,
      () => createOffloadPod(stack, pod, parseRepoRefOptions(opts.repo, opts.ref)),
      (result) => {
        success(`Created Offload pod ${result.stack}/${result.pod}`);
        info(`Lease expires at ${result.leaseExpiresAt}`);
      },
    );
  });

offloadCommand
  .command("up")
  .description("Start or renew a source-only Offload pod")
  .argument("<stack>", "Stack name")
  .argument("<pod>", "Pod name")
  .option("--json", "Emit stable machine-readable JSON")
  .action(async (stack: string, pod: string, opts: JsonOption) => {
    await runCommand(
      "up",
      opts.json,
      () => upOffloadPod(stack, pod),
      (result) => success(`Started Offload pod ${result.stack}/${result.pod}`),
    );
  });

offloadCommand
  .command("exec")
  .description("Run a command inside a source-only Offload pod")
  .argument("<stack>", "Stack name")
  .argument("<pod>", "Pod name")
  .argument("<command...>", "Command and arguments")
  .option("--dir <path>", "Working directory inside the container", "/workspace")
  .option("--json", "Emit stable machine-readable JSON")
  .allowUnknownOption()
  .action(async (stack: string, pod: string, command: string[], opts: JsonOption & { dir: string }) => {
    await runCommand(
      "exec",
      opts.json,
      () => execOffloadPod(stack, pod, command, { workdir: opts.dir }),
      (result) => {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      },
    );
  });

offloadCommand
  .command("status")
  .description("Show Offload pod metadata and container state")
  .argument("[stack]", "Stack name")
  .argument("[pod]", "Pod name")
  .option("--json", "Emit stable machine-readable JSON")
  .action(async (stack: string | undefined, pod: string | undefined, opts: JsonOption) => {
    await runCommand(
      "status",
      opts.json,
      () => statusOffloadPods({ stack, pod }),
      (result) => {
        if (result.pods.length === 0 && result.orphanedContainers.length === 0) {
          info("No Offload pods");
          return;
        }
        for (const podInfo of result.pods) {
          console.log(`${podInfo.stack}/${podInfo.pod}\t${podInfo.status}\t${podInfo.containerRunning ? "running" : "stopped"}\tlease ${podInfo.leaseExpiresAt}`);
        }
        for (const container of result.orphanedContainers) {
          console.log(`${container.stack}/${container.pod}\torphaned\trunning\t${container.name}`);
        }
      },
    );
  });

offloadCommand
  .command("lease")
  .description("Renew an Offload pod lease")
  .argument("<stack>", "Stack name")
  .argument("<pod>", "Pod name")
  .option("--json", "Emit stable machine-readable JSON")
  .action(async (stack: string, pod: string, opts: JsonOption) => {
    await runCommand(
      "lease",
      opts.json,
      () => renewOffloadLease(stack, pod),
      (result) => info(`Lease expires at ${result.leaseExpiresAt}`),
    );
  });

offloadCommand
  .command("stop")
  .description("Gracefully stop an Offload pod without deleting state")
  .argument("<stack>", "Stack name")
  .argument("<pod>", "Pod name")
  .option("--json", "Emit stable machine-readable JSON")
  .action(async (stack: string, pod: string, opts: JsonOption) => {
    await runCommand(
      "stop",
      opts.json,
      () => stopOffloadPod(stack, pod),
      (result) => success(`Stopped Offload pod ${result.stack}/${result.pod}`),
    );
  });

offloadCommand
  .command("remove")
  .description("Remove one Offload pod after Git safety checks")
  .argument("<stack>", "Stack name")
  .argument("<pod>", "Pod name")
  .option("--force", "Skip Git safety checks")
  .option("--confirm <stack/pod>", "Required exact confirmation with --force")
  .option("--json", "Emit stable machine-readable JSON")
  .action(async (stack: string, pod: string, opts: JsonOption & { force?: boolean; confirm?: string }) => {
    await runCommand(
      "remove",
      opts.json,
      () => removeOffloadPod(stack, pod, { force: opts.force, confirm: opts.confirm }),
      () => success(`Removed Offload pod ${stack}/${pod}`),
    );
  });

offloadCommand
  .command("doctor")
  .description("Check Offload backend prerequisites")
  .option("--json", "Emit stable machine-readable JSON")
  .action(async (opts: JsonOption) => {
    const result = await runCommand(
      "doctor",
      opts.json,
      () => doctorOffload(),
      (result) => {
        for (const check of result.checks) {
          console.log(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.message}`);
        }
      },
    );
    if (!result.healthy) process.exitCode = 1;
  });

offloadCommand
  .command("expire-leases", { hidden: true })
  .option("--json", "Emit stable machine-readable JSON")
  .action(async (opts: JsonOption) => {
    await runCommand(
      "expire-leases",
      opts.json,
      () => expireOffloadLeases(),
      (result) => info(`Expired ${result.expired.length} Offload lease(s)`),
    );
  });

offloadCommand
  .command("pressure-check", { hidden: true })
  .option("--json", "Emit stable machine-readable JSON")
  .action(async (opts: JsonOption) => {
    await runCommand(
      "pressure-check",
      opts.json,
      () => handleOffloadPressure(),
      (result) => info(`Pressure low count ${result.lowCount}; stopped ${result.stopped.length} pod(s)`),
    );
  });

offloadCommand
  .command("stop-all", { hidden: true })
  .option("--json", "Emit stable machine-readable JSON")
  .action(async (opts: JsonOption) => {
    await runCommand(
      "stop-all",
      opts.json,
      () => stopAllOffloadPods(),
      (result) => info(`Stopped ${result.stopped.length} Offload pod(s)`),
    );
  });
