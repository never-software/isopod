import { For, Show, createSignal, createEffect, createResource, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { fetchPods, podUp, podDown, podRecreate, podWarnings, podRemove, fetchSettings } from "../../api";
import type { Pod, RemoveWarning, ServicePort } from "../../types";
import { CreatePodWizard } from "./CreatePodWizard";

interface LogEntry {
  time: string;
  message: string;
  error?: boolean;
}

export function PodList(props: { stack?: string }) {
  const [pods, setPods] = createStore<Pod[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [actionPod, setActionPod] = createSignal<string | null>(null);
  const [statusMessage, setStatusMessage] = createSignal<string | null>(null);
  const [errorInfo, setErrorInfo] = createSignal<{ pod: string; message: string } | null>(null);
  const [logs, setLogs] = createSignal<LogEntry[]>([]);
  const [showWizard, setShowWizard] = createSignal(false);
  const [settings] = createResource(fetchSettings, { initialValue: { autoStart: false, services: [] } });

  async function refreshPods() {
    try {
      const data = await fetchPods();
      setPods(reconcile(data, { key: "name" }));
    } catch {}
    setLoading(false);
  }

  refreshPods();
  const poll = setInterval(refreshPods, 3000);
  onCleanup(() => clearInterval(poll));

  function appendLog(message: string, error = false) {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setLogs((prev) => [...prev, { time, message, error }]);
  }

  async function handleAction(pod: Pod, action: "up" | "down" | "recreate") {
    const verb = action === "up" ? "Starting" : action === "recreate" ? "Recreating" : "Stopping";
    const status = action === "up"
      ? "Starting..."
      : action === "recreate"
        ? "Recreating on latest image..."
        : "Stopping...";
    setActionPod(pod.name);
    setErrorInfo(null);
    setLogs([]);
    setStatusMessage(status);
    appendLog(`${verb} pod: ${pod.name}`);
    try {
      const onProgress = (msg: string) => {
        setStatusMessage(msg);
        appendLog(msg);
      };
      if (action === "up") {
        await podUp(pod.name, onProgress);
      } else if (action === "recreate") {
        await podRecreate(pod.name, onProgress);
      } else {
        await podDown(pod.name, onProgress);
      }
      appendLog("Done");
      refreshPods();
    } catch (e: any) {
      appendLog(e.message, true);
      setErrorInfo({ pod: pod.name, message: e.message });
      setTimeout(() => setErrorInfo(null), 5000);
    } finally {
      setActionPod(null);
      setStatusMessage(null);
    }
  }

  async function handleDelete(pod: Pod, deleteFiles: boolean) {
    setActionPod(pod.name);
    setErrorInfo(null);
    setLogs([]);
    setStatusMessage("Removing...");
    appendLog(`Removing pod: ${pod.name}`);
    try {
      await podRemove(pod.name, deleteFiles, (msg) => {
        setStatusMessage(msg);
        appendLog(msg);
      });
      appendLog("Done");
      refreshPods();
    } catch (e: any) {
      appendLog(e.message, true);
      setErrorInfo({ pod: pod.name, message: e.message });
      setTimeout(() => setErrorInfo(null), 5000);
    } finally {
      setActionPod(null);
      setStatusMessage(null);
    }
  }

  const filteredPods = () => {
    if (!props.stack) return [...pods];
    return pods.filter((p) => p.stack === props.stack);
  };

  const podsByStack = () => {
    const groups = new Map<string, Pod[]>();
    for (const pod of pods) {
      const list = groups.get(pod.stack) || [];
      list.push(pod);
      groups.set(pod.stack, list);
    }
    return Array.from(groups.entries()).map(([stack, stackPods]) => ({ stack, pods: stackPods }));
  };

  return (
    <div>
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-semibold">Pods</h2>
        <div class="flex items-center gap-3">
          <button
            class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            onClick={refreshPods}
          >
            Refresh
          </button>
          <button
            class="px-3 py-1.5 text-xs rounded-lg bg-emerald-900/50 text-emerald-400 hover:bg-emerald-900 transition-colors"
            onClick={() => setShowWizard(true)}
          >
            New Pod
          </button>
        </div>
      </div>

      <Show when={showWizard()}>
        <CreatePodWizard
          stack={props.stack!}
          onClose={() => setShowWizard(false)}
          onCreated={refreshPods}
        />
      </Show>

      <Show when={!loading()} fallback={<LoadingState />}>
        <Show
          when={pods.length > 0}
          fallback={<EmptyState />}
        >
          <Show
            when={props.stack}
            fallback={
              /* Cross-stack mode: group pods by stack */
              <div class="space-y-6">
                <For each={podsByStack()}>
                  {(group) => (
                    <div>
                      <h3 class="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">{group.stack}</h3>
                      <div class="space-y-3">
                        <For each={group.pods}>
                          {(pod) => (
                            <PodCard
                              pod={pod}
                              services={settings()?.services || []}
                              loading={actionPod() === pod.name}
                              statusMessage={actionPod() === pod.name ? statusMessage() : null}
                              error={errorInfo()?.pod === pod.name ? errorInfo()!.message : null}
                              onUp={() => handleAction(pod, "up")}
                              onDown={() => handleAction(pod, "down")}
                              onRecreate={() => handleAction(pod, "recreate")}
                              onDelete={(deleteFiles) => handleDelete(pod, deleteFiles)}
                            />
                          )}
                        </For>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            }
          >
            {/* Stack-scoped mode: flat list */}
            <div class="space-y-3">
              <For each={filteredPods()}>
                {(pod) => (
                  <PodCard
                    pod={pod}
                    services={settings()?.services || []}
                    loading={actionPod() === pod.name}
                    statusMessage={actionPod() === pod.name ? statusMessage() : null}
                    error={errorInfo()?.pod === pod.name ? errorInfo()!.message : null}
                    onUp={() => handleAction(pod, "up")}
                    onDown={() => handleAction(pod, "down")}
                    onRecreate={() => handleAction(pod, "recreate")}
                    onDelete={(deleteFiles) => handleDelete(pod, deleteFiles)}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>

      <ActivityLog entries={logs()} onClear={() => setLogs([])} />
    </div>
  );
}

function ActivityLog(props: { entries: LogEntry[]; onClear: () => void }) {
  let logEnd: HTMLDivElement | undefined;

  createEffect(() => {
    if (props.entries.length > 0) {
      logEnd?.scrollIntoView({ behavior: "smooth" });
    }
  });

  return (
    <Show when={props.entries.length > 0}>
      <div class="mt-6">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-xs font-medium text-zinc-500 uppercase tracking-wider">Activity Log</h3>
          <button
            class="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
            onClick={props.onClear}
          >
            Clear
          </button>
        </div>
        <div class="border border-zinc-800 rounded-lg bg-zinc-950 p-3 max-h-48 overflow-y-auto font-mono text-xs leading-5">
          <For each={props.entries}>
            {(entry) => (
              <div class={entry.error ? "text-red-400" : "text-zinc-400"}>
                <span class="text-zinc-600 select-none">{entry.time}</span>{" "}
                {entry.message}
              </div>
            )}
          </For>
          <div ref={logEnd} />
        </div>
      </div>
    </Show>
  );
}

function PodCard(props: {
  pod: Pod;
  services: ServicePort[];
  loading: boolean;
  statusMessage: string | null;
  error: string | null;
  onUp: () => void;
  onDown: () => void;
  onRecreate: () => void;
  onDelete: (deleteFiles: boolean) => void;
}) {
  const isRunning = () => props.pod.container.state === "running";
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [deleteFiles, setDeleteFiles] = createSignal(true);
  const [warnings, setWarnings] = createSignal<RemoveWarning[]>([]);
  const [loadingWarnings, setLoadingWarnings] = createSignal(false);

  async function handleDeleteClick() {
    setLoadingWarnings(true);
    try {
      const w = await podWarnings(props.pod.name);
      setWarnings(w);
    } catch { setWarnings([]); }
    setLoadingWarnings(false);
    setConfirmDelete(true);
  }

  return (
    <div class={`border rounded-lg bg-zinc-900/50 p-4 ${props.error ? "border-red-900/50" : "border-zinc-800"}`}>
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-3">
          <Show
            when={!props.loading}
            fallback={
              <span class="w-2.5 h-2.5 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
            }
          >
            <span
              class={`w-2.5 h-2.5 rounded-full ${
                props.error ? "bg-red-500" : isRunning() ? "bg-emerald-500" : "bg-zinc-600"
              }`}
            />
          </Show>
          <h3 class="font-medium">{props.pod.name}</h3>
          <Show when={props.pod.stack}>
            <span class="text-xs bg-violet-900/50 text-violet-400 px-1.5 py-0.5 rounded">{props.pod.stack}</span>
          </Show>
        </div>

        <div class="flex items-center gap-2">
          <span class={`text-xs ${props.error ? "text-red-400" : "text-zinc-500"}`}>
            {props.error
              ? props.error
              : props.loading && props.statusMessage
                ? props.statusMessage
                : (props.pod.container.status || props.pod.container.state)}
          </span>
          <Show when={!props.loading && !props.error}>
            <Show
              when={isRunning()}
              fallback={
                <div class="flex items-center gap-1.5">
                  <button
                    class="px-2.5 py-1 text-xs rounded bg-emerald-900/50 text-emerald-400 hover:bg-emerald-900 transition-colors"
                    onClick={props.onUp}
                  >
                    Start
                  </button>
                  <button
                    class="px-2.5 py-1 text-xs rounded bg-sky-900/50 text-sky-400 hover:bg-sky-900 transition-colors"
                    onClick={props.onRecreate}
                    title="Recreate container on the latest base image — keeps your code, database & shared home."
                  >
                    Recreate
                  </button>
                  <button
                    class="px-2.5 py-1 text-xs rounded bg-zinc-800 text-red-400/70 hover:bg-red-900/30 hover:text-red-400 transition-colors"
                    onClick={handleDeleteClick}
                    disabled={loadingWarnings()}
                  >
                    Delete
                  </button>
                </div>
              }
            >
              <div class="flex items-center gap-1.5">
                <button
                  class="px-2.5 py-1 text-xs rounded bg-sky-900/50 text-sky-400 hover:bg-sky-900 transition-colors"
                  onClick={props.onRecreate}
                  title="Recreate container on the latest base image — keeps your code, database & shared home."
                >
                  Recreate
                </button>
                <button
                  class="px-2.5 py-1 text-xs rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-colors"
                  onClick={props.onDown}
                >
                  Stop
                </button>
              </div>
            </Show>
          </Show>
        </div>
      </div>

      <Show when={props.pod.repos.length > 0}>
        <div class="flex flex-wrap gap-2">
          <For each={props.pod.repos}>
            {(repo) => (
              <div class="flex items-center gap-1.5 text-xs bg-zinc-800/50 rounded px-2 py-1">
                <span class="text-zinc-400">{repo.name}</span>
                <span class="text-zinc-600">/</span>
                <span class="text-cyan-400 font-mono">{repo.branch}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={isRunning() && props.services.length > 0}>
        <div class="flex flex-wrap gap-2 mt-2">
          <For each={props.services}>
            {(svc) => (
              <a
                href={`${svc.protocol}://ip-${props.pod.stack}-${props.pod.name}.orb.local:${svc.port}`}
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-center gap-1 text-xs text-cyan-400/70 hover:text-cyan-300 transition-colors"
              >
                <span>{svc.label}</span>
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </a>
            )}
          </For>
        </div>
      </Show>

      <Show when={confirmDelete()}>
        <div class="mt-3 border border-red-900/50 rounded-lg bg-red-950/30 p-3">
          <Show when={warnings().length > 0}>
            <p class="text-xs text-red-400 font-medium mb-2">
              {deleteFiles()
                ? "Unsaved work that will be permanently lost:"
                : "Unsaved work in this pod (kept on disk if files are kept):"}
            </p>
            <div class="space-y-1 mb-3">
              <For each={warnings()}>
                {(w) => (
                  <div class="text-xs text-red-300/80">
                    <span class="text-zinc-400">{w.repo}</span> — {w.message}
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={warnings().length === 0}>
            <p class="text-xs text-zinc-400 mb-3">No unsaved work detected. Safe to remove.</p>
          </Show>
          <label class="flex items-center gap-2 text-xs text-zinc-400 mb-3 cursor-pointer select-none">
            <input
              type="checkbox"
              class="accent-red-500"
              checked={deleteFiles()}
              onChange={(e) => setDeleteFiles(e.currentTarget.checked)}
            />
            Also delete folder contents (repo clones on disk)
          </label>
          <div class="flex items-center gap-2">
            <button
              class="px-2.5 py-1 text-xs rounded bg-red-900/50 text-red-400 hover:bg-red-900 transition-colors"
              onClick={() => { setConfirmDelete(false); props.onDelete(deleteFiles()); }}
            >
              {deleteFiles() ? "Remove pod" : "Remove pod, keep files"}
            </button>
            <button
              class="px-2.5 py-1 text-xs rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-colors"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

function LoadingState() {
  return (
    <div class="text-sm text-zinc-500 animate-pulse">Loading pods...</div>
  );
}

function EmptyState() {
  return (
    <div class="text-sm text-zinc-500 border border-dashed border-zinc-800 rounded-lg p-8 text-center">
      No pods found. Create one with{" "}
      <code class="text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">
        isopod create &lt;name&gt;
      </code>
    </div>
  );
}
