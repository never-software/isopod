import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { config } from "./config.js";

/**
 * Per-stack service manifest (`docker.local/services.json`) — the single source
 * of truth for a stack's long-running dev services. From it we GENERATE the
 * surfaces that otherwise drift out of sync:
 *
 *   - code-server/settings.json  (.["startupTerminals.terminals"] — tail -F + cd workdir)
 *   - code-server/tasks.json     (start/stop/restart per service; stop kills by port)
 *   - services-start.sh          (pre-create logs + start services; bind-mounted in)
 *   - hooks/urls                 (one "label<TAB>url" line per service with a URL)
 *
 * Generation is host-side and pure TypeScript (no jq). The artifacts are
 * regenerated on every `isopod up`, so a port/command change in services.json
 * takes effect on the next pod start with no image rebuild. A malformed manifest
 * throws (failing `up` loudly) rather than silently doing nothing.
 *
 * Robust tailing: every log is pre-created (`: > logPath`) BEFORE code-server
 * boots, and startup terminals use `tail -F` (retry + follow-by-name), so a
 * terminal never shows "tail: cannot open ..." while its service is still
 * starting.
 */
export interface ServiceDef {
  /** Stable identifier (unused at runtime; aids manifest readability). */
  id: string;
  /** Human label used for the terminal name, task label, and (with port) the URL. */
  displayName: string;
  /** Service port — emits a URL (with urlLabel) and is the default stop target. */
  port?: number;
  /** URL scheme. Default "http". */
  protocol?: "http" | "https";
  /** When set, hooks/urls emits a "<urlLabel><TAB><url>" line for this service. */
  urlLabel?: string;
  /** Directory the service runs in (cd'd into before the command / tail). */
  workdir?: string;
  /** Log file the service writes to. Enables the tail terminal + log pre-creation. */
  logPath?: string;
  /** Command that launches the service (enables start/stop/restart tasks). */
  startCommand?: string;
  /** Port to kill on stop/restart. Defaults to `port`. */
  stopPort?: number;
  /** Override the startup-terminal command (e.g. "cd /workspace && claude"). */
  terminalCommand?: string;
  /** Open a startup terminal for this service. Default true. */
  tailInTerminal?: boolean;
  /** Launch this service from services-start.sh's start_services(). Default true. */
  autoStart?: boolean;
}

export interface ServiceManifest {
  /**
   * Template for the URL host in hooks/urls. `${STACK}` is substituted at
   * generation time (the stack name is fixed per docker.local dir);
   * `${FEATURE_NAME}` (and any other env the urls hook receives) is preserved
   * verbatim and expands at hook runtime. Default
   * "ip-${STACK}-${FEATURE_NAME}.orb.local" — the container name the CLI
   * assigns (see containerName()), which is what OrbStack DNS resolves.
   */
  urlHost?: string;
  services: ServiceDef[];
}

const GENERATED_MARKER =
  "GENERATED from services.json — do not edit; edit services.json and re-run isopod up";

const DEFAULT_URL_HOST = "ip-${STACK}-${FEATURE_NAME}.orb.local";

/** Path to a stack's service manifest within its docker.local directory. */
export function servicesManifestPath(dockerDir: string): string {
  return join(dockerDir, "services.json");
}

/**
 * Read + validate a stack's manifest. Returns null when absent; throws on
 * unreadable / invalid JSON or a missing `services` array (so `up` fails loudly).
 */
export function readManifest(dockerDir: string): ServiceManifest | null {
  const path = servicesManifestPath(dockerDir);
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read service manifest ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in service manifest ${path}: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as ServiceManifest).services)) {
    throw new Error(`Service manifest ${path} must be an object with a "services" array`);
  }

  return parsed as ServiceManifest;
}

/**
 * POSIX single-quote a path/token for use in shell, but leave already-safe
 * tokens bare so the common case (`/workspace/api`) stays readable. This is the
 * TS equivalent of jq's @sh applied to a single string.
 */
const SAFE_SHELL_TOKEN = /^[A-Za-z0-9_@%:=+,./-]+$/;
function shq(value: string): string {
  if (SAFE_SHELL_TOKEN.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function cdPrefix(svc: ServiceDef): string {
  return svc.workdir ? `cd ${shq(svc.workdir)} && ` : "";
}

function hasTerminal(svc: ServiceDef): boolean {
  return svc.tailInTerminal !== false && (!!svc.terminalCommand || !!svc.logPath);
}

function terminalCommandFor(svc: ServiceDef): string {
  if (svc.terminalCommand) return svc.terminalCommand;
  return `${cdPrefix(svc)}tail -F ${shq(svc.logPath!)}`;
}

function startCommandFor(svc: ServiceDef): string {
  return `${cdPrefix(svc)}${svc.startCommand}`;
}

function stopPortFor(svc: ServiceDef): number | undefined {
  return svc.stopPort ?? svc.port;
}

function stopCommandFor(svc: ServiceDef): string {
  return `lsof -ti tcp:${stopPortFor(svc)} | xargs -r kill -TERM`;
}

/**
 * Update only the `startupTerminals.terminals` key in code-server/settings.json,
 * preserving every other setting (theme, fonts, terminal profiles, …).
 */
function generateSettings(dockerDir: string, manifest: ServiceManifest): void {
  const dir = join(dockerDir, "code-server");
  const settingsPath = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch (err) {
      // settings.json is code-server's LIVE, machine-managed file (it rewrites it
      // at runtime) and is shared across every pod in the stack. A transient
      // partial write must not block `isopod up` for the whole stack, and we must
      // not clobber the user's real settings with a reduced version — so warn and
      // skip only the terminals update this run (code-server repairs the file; the
      // terminals regenerate next up). The manifest itself still fails loud.
      console.warn(
        `isopod: skipping startupTerminals update — ${settingsPath} is not valid JSON ` +
          `(${(err as Error).message}); leaving it for code-server to repair`,
      );
      return;
    }
  }

  settings["startupTerminals.terminals"] = manifest.services
    .filter(hasTerminal)
    .map((svc) => ({ name: svc.displayName, command: terminalCommandFor(svc) }));

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Regenerate code-server/tasks.json: start/stop/restart per service with a
 * startCommand. Stop/restart kill by port via lsof (no brittle process-name
 * matching), so they're emitted only when a port is resolvable.
 */
function generateTasks(dockerDir: string, manifest: ServiceManifest): void {
  const dir = join(dockerDir, "code-server");
  mkdirSync(dir, { recursive: true });

  const presentation = { reveal: "always", panel: "dedicated", group: "services", showReuseMessage: false };
  const tasks: unknown[] = [];

  for (const svc of manifest.services) {
    if (!svc.startCommand) continue;

    tasks.push({
      label: `${svc.displayName}: start`,
      type: "shell",
      command: startCommandFor(svc),
      isBackground: true,
      problemMatcher: [],
      presentation,
    });

    if (stopPortFor(svc) != null) {
      tasks.push({
        label: `${svc.displayName}: stop`,
        type: "shell",
        command: stopCommandFor(svc),
        problemMatcher: [],
      });
      tasks.push({
        label: `${svc.displayName}: restart`,
        type: "shell",
        command: `${stopCommandFor(svc)}; sleep 1; ${startCommandFor(svc)}`,
        isBackground: true,
        problemMatcher: [],
        presentation,
      });
    }
  }

  const body = JSON.stringify({ version: "2.0.0", tasks }, null, 2);
  writeFileSync(join(dir, "tasks.json"), `// ${GENERATED_MARKER}\n${body}\n`);
}

/**
 * Regenerate services-start.sh (sourced by workspace-start.sh):
 *   precreate_logs()  — touch every service log up front (before code-server)
 *   start_services()  — launch each autoStart service in the background to its log
 */
function generateRunner(dockerDir: string, manifest: ServiceManifest): void {
  const lines = [
    "#!/bin/bash",
    `# ${GENERATED_MARKER}.`,
    "# Sourced by workspace-start.sh; defines precreate_logs and start_services.",
    "",
    "precreate_logs() {",
  ];
  for (const svc of manifest.services) {
    if (svc.logPath) lines.push(`  : > ${shq(svc.logPath)}`);
  }
  lines.push("  return 0", "}", "", "start_services() {");
  for (const svc of manifest.services) {
    if (!svc.startCommand || svc.autoStart === false) continue;
    const log = svc.logPath ? shq(svc.logPath) : "/dev/null";
    lines.push(`  ( ${startCommandFor(svc)} ) &> ${log} &`);
  }
  lines.push("  return 0", "}", "");

  const runner = join(dockerDir, "services-start.sh");
  writeFileSync(runner, lines.join("\n"));
  chmodSync(runner, 0o755);
}

/**
 * Regenerate hooks/urls so the URL list never drifts from the manifest. Emits
 * `printf '%s\t%s\n' <label> "<scheme>://<host>:<port>"` for each service with a
 * urlLabel + port. The host template (e.g. ${FEATURE_NAME}) stays a shell
 * variable, expanded when the hook runs with FEATURE_NAME in its environment.
 */
function generateUrlsHook(dockerDir: string, manifest: ServiceManifest, stack?: string): void {
  const hookDir = join(dockerDir, "hooks");
  mkdirSync(hookDir, { recursive: true });

  let host = manifest.urlHost ?? DEFAULT_URL_HOST;
  if (stack) host = host.replaceAll("${STACK}", stack);
  const lines = [
    "#!/bin/bash",
    `# ${GENERATED_MARKER}.`,
    "# hooks/urls — service URLs for display after create/up (one per line: label<TAB>url).",
    "set -euo pipefail",
    "",
  ];
  for (const svc of manifest.services) {
    if (!svc.urlLabel || svc.port == null) continue;
    const url = `${svc.protocol ?? "http"}://${host}:${svc.port}`;
    lines.push(`printf '%s\\t%s\\n' ${shq(svc.urlLabel)} "${url}"`);
  }

  const hookPath = join(hookDir, "urls");
  writeFileSync(hookPath, lines.join("\n") + "\n");
  chmodSync(hookPath, 0o755);
}

/**
 * No-manifest fallback: a runner whose hooks are no-ops, so a compose bind mount
 * of services-start.sh always has a source file (Docker would otherwise create a
 * directory in its place).
 */
function generateStubRunner(dockerDir: string): void {
  const runner = join(dockerDir, "services-start.sh");
  writeFileSync(
    runner,
    [
      "#!/bin/bash",
      "# No services.json found — no managed services. (stub)",
      "precreate_logs() { return 0; }",
      "start_services() { return 0; }",
      "",
    ].join("\n"),
  );
  chmodSync(runner, 0o755);
}

/**
 * Regenerate every manifest-derived surface in a docker.local directory.
 * Exported separately from {@link generateServices} so it can be exercised in
 * tests against an arbitrary directory.
 */
export function generateServicesInDir(dockerDir: string, stack?: string): void {
  if (!existsSync(dockerDir)) return;

  const manifest = readManifest(dockerDir);
  if (!manifest) {
    generateStubRunner(dockerDir);
    return;
  }

  generateSettings(dockerDir, manifest);
  generateTasks(dockerDir, manifest);
  generateRunner(dockerDir, manifest);
  generateUrlsHook(dockerDir, manifest, stack);
}

/** Regenerate a stack's service surfaces from its docker.local/services.json. */
export function generateServices(stack: string): void {
  generateServicesInDir(config.stackDockerDir(stack), stack);
}
