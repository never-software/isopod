// Tests for the service-manifest generator (src/services.ts → dist/services.js).
//
// generateServicesInDir is a pure host-side transform: services.json → generated
// surfaces (code-server settings/tasks, services-start.sh, hooks/urls). These
// tests are Docker-free. Run after `npm run build`:
//
//   node --test test/
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateServicesInDir, readManifest } from "../dist/services.js";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "isopod-services-"));
}

function writeManifest(dir, manifest) {
  writeFileSync(join(dir, "services.json"), JSON.stringify(manifest, null, 2));
}

const RAILS_REACT = {
  urlHost: "${FEATURE_NAME}.orb.local",
  services: [
    { id: "ide", displayName: "IDE", port: 8443, protocol: "https", urlLabel: "IDE", tailInTerminal: false, autoStart: false },
    { id: "rails", displayName: "Rails API", port: 3000, protocol: "https", urlLabel: "API",
      workdir: "/workspace/example-api", logPath: "/tmp/rails.log",
      startCommand: "rm -f tmp/pids/server.pid; bundle exec rails server -b 0.0.0.0 -p 3000" },
    { id: "vite", displayName: "Frontend", port: 4000, protocol: "https", urlLabel: "Frontend",
      workdir: "/workspace/example-frontend", logPath: "/tmp/vite.log",
      startCommand: "VITE_API_URL=http://localhost:3000 npx vite --host 0.0.0.0 --port 4000" },
  ],
};

test("settings: startup terminals use tail -F + cd workdir, IDE excluded", () => {
  const dir = freshDir();
  writeManifest(dir, RAILS_REACT);
  generateServicesInDir(dir);

  const settings = JSON.parse(readFileSync(join(dir, "code-server", "settings.json"), "utf-8"));
  const terms = settings["startupTerminals.terminals"];
  assert.deepEqual(terms, [
    { name: "Rails API", command: "cd /workspace/example-api && tail -F /tmp/rails.log" },
    { name: "Frontend", command: "cd /workspace/example-frontend && tail -F /tmp/vite.log" },
  ]);
  // robust tailing only — never the racy lowercase form
  assert.ok(!JSON.stringify(terms).includes("tail -f "));
  rmSync(dir, { recursive: true, force: true });
});

test("settings: other keys are preserved", () => {
  const dir = freshDir();
  mkdirSync(join(dir, "code-server"), { recursive: true });
  writeFileSync(
    join(dir, "code-server", "settings.json"),
    JSON.stringify({ "editor.fontSize": 14, "startupTerminals.terminals": [] }, null, 2),
  );
  writeManifest(dir, RAILS_REACT);
  generateServicesInDir(dir);

  const settings = JSON.parse(readFileSync(join(dir, "code-server", "settings.json"), "utf-8"));
  assert.equal(settings["editor.fontSize"], 14);
  assert.equal(settings["startupTerminals.terminals"].length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("settings: a corrupt LIVE settings.json is tolerated (warn, skip, don't clobber or throw)", () => {
  const dir = freshDir();
  mkdirSync(join(dir, "code-server"), { recursive: true });
  const settingsPath = join(dir, "code-server", "settings.json");
  const corrupt = '{ "editor.fontSize": 14, '; // code-server mid-write
  writeFileSync(settingsPath, corrupt);
  writeManifest(dir, RAILS_REACT);

  const realWarn = console.warn;
  console.warn = () => {};
  try {
    // must NOT throw — settings.json is code-server's machine-managed file
    assert.doesNotThrow(() => generateServicesInDir(dir));
  } finally {
    console.warn = realWarn;
  }
  // the corrupt file is left untouched (not clobbered with a reduced version)
  assert.equal(readFileSync(settingsPath, "utf-8"), corrupt);
  // but the other artifacts still generate, so `up` proceeds
  assert.ok(existsSync(join(dir, "code-server", "tasks.json")));
  assert.ok(existsSync(join(dir, "services-start.sh")));
  assert.ok(existsSync(join(dir, "hooks", "urls")));
  rmSync(dir, { recursive: true, force: true });
});

test("tasks: start/stop/restart per service, stop kills by port via lsof", () => {
  const dir = freshDir();
  writeManifest(dir, RAILS_REACT);
  generateServicesInDir(dir);

  const raw = readFileSync(join(dir, "code-server", "tasks.json"), "utf-8");
  assert.ok(raw.startsWith("// GENERATED from services.json"));
  // valid JSON once the leading // header line is stripped
  const body = JSON.parse(raw.split("\n").slice(1).join("\n"));
  const labels = body.tasks.map((t) => t.label);
  assert.deepEqual(labels, [
    "Rails API: start", "Rails API: stop", "Rails API: restart",
    "Frontend: start", "Frontend: stop", "Frontend: restart",
  ]);
  const stop = body.tasks.find((t) => t.label === "Rails API: stop");
  assert.equal(stop.command, "lsof -ti tcp:3000 | xargs -r kill -TERM");
  // IDE has no startCommand → no task
  assert.ok(!labels.some((l) => l.startsWith("IDE")));
  rmSync(dir, { recursive: true, force: true });
});

test("runner: pre-creates every log and starts autoStart services; valid bash", () => {
  const dir = freshDir();
  writeManifest(dir, RAILS_REACT);
  generateServicesInDir(dir);

  const runner = join(dir, "services-start.sh");
  const body = readFileSync(runner, "utf-8");
  assert.ok(body.includes("precreate_logs()"));
  assert.ok(body.includes("start_services()"));
  // the race fix: logs pre-created up front
  assert.ok(body.includes(": > /tmp/rails.log"));
  assert.ok(body.includes(": > /tmp/vite.log"));
  // services launched in background, redirected to their log
  assert.ok(body.includes("( cd /workspace/example-api && rm -f tmp/pids/server.pid; bundle exec rails server -b 0.0.0.0 -p 3000 ) &> /tmp/rails.log &"));
  // generated runner is valid bash
  execSync(`bash -n ${runner}`);
  rmSync(dir, { recursive: true, force: true });
});

test("urls hook: one line per service with a URL, scheme/host/port from manifest; valid bash", () => {
  const dir = freshDir();
  writeManifest(dir, RAILS_REACT);
  generateServicesInDir(dir);

  const hook = join(dir, "hooks", "urls");
  const body = readFileSync(hook, "utf-8");
  execSync(`bash -n ${hook}`);
  // run the hook with a feature name and parse its tab-separated output
  const out = execSync(`FEATURE_NAME=demo bash ${hook}`, { encoding: "utf-8" }).trim();
  const lines = out.split("\n").map((l) => l.split("\t"));
  assert.deepEqual(lines, [
    ["IDE", "https://demo.orb.local:8443"],
    ["API", "https://demo.orb.local:3000"],
    ["Frontend", "https://demo.orb.local:4000"],
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("shell escaping: paths with spaces are quoted; runner stays valid + precreate works", () => {
  const dir = freshDir();
  const logPath = join(dir, "a b", "svc.log"); // space in the path
  mkdirSync(join(dir, "a b"), { recursive: true });
  writeManifest(dir, {
    services: [{ id: "t", displayName: "T", port: 7000, urlLabel: "T",
      workdir: "/work space/app", logPath, startCommand: "true" }],
  });
  generateServicesInDir(dir);

  const runner = join(dir, "services-start.sh");
  const body = readFileSync(runner, "utf-8");
  assert.ok(body.includes(`: > '${logPath}'`), "space path single-quoted in precreate");
  assert.ok(body.includes("cd '/work space/app'"), "space workdir single-quoted");
  execSync(`bash -n ${runner}`);
  // functionally: sourcing + precreate_logs actually creates the spaced log file
  execSync(`bash -c 'source ${JSON.stringify(runner)}; precreate_logs'`);
  assert.ok(existsSync(logPath), "precreate_logs created the spaced log path");
  rmSync(dir, { recursive: true, force: true });
});

test("orri shape: autoStart:false → empty start_services; terminalCommand + urlHost honored", () => {
  const dir = freshDir();
  writeManifest(dir, {
    urlHost: "ip-orri-${FEATURE_NAME}.orb.local",
    services: [
      { id: "ide", displayName: "IDE", port: 8443, protocol: "https", urlLabel: "IDE", tailInTerminal: false, autoStart: false },
      { id: "claude", displayName: "Claude", terminalCommand: "cd /workspace && claude", autoStart: false },
      { id: "rails-dev", displayName: "Rails (dev)", port: 3000, urlLabel: "API dev",
        workdir: "/workspace/api", logPath: "/tmp/rails-dev.log",
        startCommand: "bundle exec rails server -b 0.0.0.0 -p 3000", autoStart: false },
    ],
  });
  generateServicesInDir(dir);

  const runner = readFileSync(join(dir, "services-start.sh"), "utf-8");
  // logs still pre-created, but nothing auto-launched (all autoStart:false)
  assert.ok(runner.includes(": > /tmp/rails-dev.log"));
  assert.ok(!runner.includes("&>"), "start_services must be empty when all services are autoStart:false");

  const settings = JSON.parse(readFileSync(join(dir, "code-server", "settings.json"), "utf-8"));
  const terms = settings["startupTerminals.terminals"];
  assert.deepEqual(terms[0], { name: "Claude", command: "cd /workspace && claude" });
  assert.equal(terms[1].command, "cd /workspace/api && tail -F /tmp/rails-dev.log");

  // tasks still generated for the autoStart:false service (manual restart from palette)
  const tasks = JSON.parse(readFileSync(join(dir, "code-server", "tasks.json"), "utf-8").split("\n").slice(1).join("\n"));
  assert.ok(tasks.tasks.some((t) => t.label === "Rails (dev): start"));

  const urls = execSync(`FEATURE_NAME=feat bash ${join(dir, "hooks", "urls")}`, { encoding: "utf-8" });
  assert.ok(urls.includes("https://ip-orri-feat.orb.local:8443"));
  assert.ok(urls.includes("http://ip-orri-feat.orb.local:3000"));
  rmSync(dir, { recursive: true, force: true });
});

test("urls hook: ${STACK} in urlHost is substituted at generation time", () => {
  const dir = freshDir();
  writeManifest(dir, {
    urlHost: "ip-${STACK}-${FEATURE_NAME}.orb.local",
    services: [{ id: "ide", displayName: "IDE", port: 8443, protocol: "https", urlLabel: "IDE", tailInTerminal: false, autoStart: false }],
  });
  generateServicesInDir(dir, "mystack");

  const body = readFileSync(join(dir, "hooks", "urls"), "utf-8");
  assert.ok(!body.includes("${STACK}"), "stack baked in — no runtime ${STACK} left");
  const out = execSync(`FEATURE_NAME=demo bash ${join(dir, "hooks", "urls")}`, { encoding: "utf-8" }).trim();
  assert.equal(out, "IDE\thttps://ip-mystack-demo.orb.local:8443");
  rmSync(dir, { recursive: true, force: true });
});

test("invalid JSON in the manifest throws loudly", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "services.json"), "{ not json");
  assert.throws(() => readManifest(dir), /Invalid JSON/);
  assert.throws(() => generateServicesInDir(dir), /Invalid JSON/);
  rmSync(dir, { recursive: true, force: true });
});

test("no manifest: a stub runner is written with no-op functions", () => {
  const dir = freshDir();
  generateServicesInDir(dir);
  const runner = join(dir, "services-start.sh");
  assert.ok(existsSync(runner));
  const body = readFileSync(runner, "utf-8");
  assert.ok(body.includes("stub"));
  // stub functions exist and succeed
  execSync(`bash -c 'source ${JSON.stringify(runner)}; precreate_logs && start_services'`);
  rmSync(dir, { recursive: true, force: true });
});
