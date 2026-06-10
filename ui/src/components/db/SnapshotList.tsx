import { createResource, createSignal, For, Show } from "solid-js";
import { fetchSnapshots, fetchPods, createSnapshot, restoreSnapshot } from "../../api";
import type { Pod, Snapshot } from "../../types";

interface Props {
  stack?: string;
}

export function SnapshotList(props: Props) {
  const [allSnapshots, { refetch }] = createResource(fetchSnapshots, { initialValue: [] });
  const snapshots = () =>
    (allSnapshots() || []).filter((s) => !props.stack || s.stack === props.stack);
  const [showModal, setShowModal] = createSignal(false);
  const [restoreTarget, setRestoreTarget] = createSignal<Snapshot | null>(null);

  return (
    <div>
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-semibold">Database Snapshots</h2>
        <div class="flex items-center gap-3">
          <button
            class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            onClick={() => refetch()}
          >
            Refresh
          </button>
          <button
            class="px-3 py-1.5 text-xs rounded-lg bg-emerald-900/50 text-emerald-400 hover:bg-emerald-900 transition-colors"
            onClick={() => setShowModal(true)}
          >
            Create Snapshot
          </button>
        </div>
      </div>

      <Show when={!allSnapshots.loading} fallback={
        <div class="text-sm text-zinc-500 animate-pulse">Loading snapshots...</div>
      }>
        <Show
          when={snapshots().length > 0}
          fallback={
            <div class="text-sm text-zinc-500 border border-dashed border-zinc-800 rounded-lg p-8 text-center">
              No snapshots yet. Click <span class="text-zinc-300">Create Snapshot</span> to save one from a running pod.
            </div>
          }
        >
          <div class="border border-zinc-800 rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-zinc-900 text-zinc-500 text-xs uppercase tracking-wider">
                  <th class="text-left px-4 py-2.5 font-medium">Stack</th>
                  <th class="text-left px-4 py-2.5 font-medium">Name</th>
                  <th class="text-left px-4 py-2.5 font-medium">Volume</th>
                  <th class="text-right px-4 py-2.5 font-medium">Created</th>
                  <th class="text-right px-4 py-2.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-zinc-800/50">
                <For each={snapshots()}>
                  {(snap) => (
                    <tr class="hover:bg-zinc-800/30 transition-colors">
                      <td class="px-4 py-2.5 text-zinc-400 font-mono text-xs">{snap.stack}</td>
                      <td class="px-4 py-2.5 font-medium text-zinc-200">{snap.name}</td>
                      <td class="px-4 py-2.5 font-mono text-xs text-zinc-500">{snap.volume}</td>
                      <td class="px-4 py-2.5 text-right text-zinc-400">{snap.created}</td>
                      <td class="px-4 py-2.5 text-right">
                        <button
                          class="px-2.5 py-1 text-xs rounded-md bg-sky-900/40 text-sky-300 hover:bg-sky-900 transition-colors"
                          onClick={() => setRestoreTarget(snap)}
                        >
                          Restore
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>

      <Show when={showModal()}>
        <CreateSnapshotModal
          stack={props.stack}
          existing={snapshots() || []}
          onClose={() => setShowModal(false)}
          onCreated={() => refetch()}
        />
      </Show>

      <Show when={restoreTarget()}>
        <RestoreSnapshotModal
          snapshot={restoreTarget()!}
          onClose={() => setRestoreTarget(null)}
          onRestored={() => refetch()}
        />
      </Show>
    </div>
  );
}

// ── Create Snapshot Modal ────────────────────────────────────────────

interface ModalProps {
  stack?: string;
  existing: Snapshot[];
  onClose: () => void;
  onCreated: () => void;
}

function CreateSnapshotModal(props: ModalProps) {
  const [pods] = createResource(fetchPods, { initialValue: [] });
  const [selectedPod, setSelectedPod] = createSignal("");
  const [snapName, setSnapName] = createSignal("");
  const [error, setError] = createSignal("");
  const [logs, setLogs] = createSignal<string[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [done, setDone] = createSignal(false);

  const runningPods = () => {
    const all = pods() || [];
    return all.filter((p: Pod) =>
      p.container.state === "running" &&
      (!props.stack || p.stack === props.stack)
    );
  };

  const snapNameExists = () =>
    !!snapName().trim() && props.existing.some((s) => s.name === snapName().trim());

  async function submit() {
    const pod = selectedPod();
    const snap = snapName().trim();

    if (!pod) {
      setError("Select a pod");
      return;
    }
    if (!snap) {
      setError("Snapshot name is required");
      return;
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(snap)) {
      setError("Use only letters, numbers, dashes, and underscores");
      return;
    }

    setError("");
    setLogs([]);
    setSaving(true);

    try {
      await createSnapshot(pod, snap, (msg) => setLogs((prev) => [...prev, msg]));
      setDone(true);
      props.onCreated();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/60">
      <div class="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-2xl shadow-2xl">
        <div class="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h3 class="text-base font-semibold">Create Snapshot</h3>
          <Show when={!saving()}>
            <button
              class="text-zinc-500 hover:text-zinc-300 text-sm"
              onClick={props.onClose}
            >
              {done() ? "Close" : "Cancel"}
            </button>
          </Show>
        </div>

        <div class="p-5 space-y-4">
          <Show when={!done()}>
            <div>
              <label class="text-xs text-zinc-500 block mb-1.5">
                Source Pod
                <Show when={props.stack}>
                  <span class="text-zinc-600"> — {props.stack} stack</span>
                </Show>
              </label>
              <Show
                when={!pods.loading}
                fallback={<div class="text-xs text-zinc-500 animate-pulse">Loading pods...</div>}
              >
                <Show
                  when={runningPods().length > 0}
                  fallback={
                    <div class="text-xs text-zinc-500 border border-dashed border-zinc-800 rounded-lg p-4 text-center">
                      No running pods{props.stack ? ` in ${props.stack}` : ""}. Start a pod first.
                    </div>
                  }
                >
                  <div class="space-y-1">
                    <For each={runningPods()}>
                      {(pod) => (
                        <label class="flex items-center gap-2.5 px-3 py-2 rounded border border-zinc-800 bg-zinc-950 cursor-pointer hover:bg-zinc-800/30 transition-colors">
                          <input
                            type="radio"
                            name="pod"
                            checked={selectedPod() === pod.name}
                            onChange={() => setSelectedPod(pod.name)}
                            disabled={saving()}
                            class="accent-emerald-500"
                          />
                          <span class="text-sm text-zinc-300">{pod.name}</span>
                          <Show when={!props.stack}>
                            <span class="text-xs text-zinc-600 font-mono">{pod.stack}</span>
                          </Show>
                          <span class="text-xs text-zinc-600 ml-auto">{pod.container.status}</span>
                        </label>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>

            <div>
              <label class="text-xs text-zinc-500 block mb-1.5">Snapshot Name</label>
              <input
                type="text"
                placeholder="baseline"
                class="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
                value={snapName()}
                onInput={(e) => setSnapName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && !saving() && submit()}
                disabled={saving()}
              />
              <Show when={snapNameExists() && !saving()}>
                <p class="text-xs text-amber-400 mt-1">
                  A snapshot named "{snapName().trim()}" already exists — it will be overwritten.
                </p>
              </Show>
            </div>
          </Show>

          <Show when={error()}>
            <div class="text-sm text-red-400">{error()}</div>
          </Show>

          <Show when={logs().length > 0}>
            <div class="border border-zinc-800 rounded-lg bg-zinc-950 p-3 max-h-64 overflow-auto font-mono text-xs">
              <For each={logs()}>
                {(line) => <div class="py-0.5 text-zinc-500">{line}</div>}
              </For>
            </div>
          </Show>

          <Show when={done()}>
            <div class="text-sm text-emerald-400">Snapshot saved successfully.</div>
          </Show>

          <Show when={!done()}>
            <div class="flex justify-end pt-2">
              <button
                class="px-4 py-2 text-sm rounded-lg bg-emerald-900/50 text-emerald-400 hover:bg-emerald-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={submit}
                disabled={saving() || !selectedPod() || !snapName().trim()}
              >
                {saving() ? "Saving..." : "Save Snapshot"}
              </button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

// ── Restore Snapshot Modal ───────────────────────────────────────────

interface RestoreModalProps {
  snapshot: Snapshot;
  onClose: () => void;
  onRestored: () => void;
}

function RestoreSnapshotModal(props: RestoreModalProps) {
  const [pods] = createResource(fetchPods, { initialValue: [] });
  const [selectedPod, setSelectedPod] = createSignal("");
  const [error, setError] = createSignal("");
  const [logs, setLogs] = createSignal<string[]>([]);
  const [restoring, setRestoring] = createSignal(false);
  const [done, setDone] = createSignal(false);

  // Restore is same-stack only: dbRestore derives the stack from the target
  // pod and looks up ip-<stack>-<snapshot>, so a snapshot can only land on a
  // running pod within its own stack.
  const targetPods = () => {
    const all = pods() || [];
    return all.filter(
      (p: Pod) => p.container.state === "running" && p.stack === props.snapshot.stack,
    );
  };

  async function submit() {
    const pod = selectedPod();
    if (!pod) {
      setError("Select a target pod");
      return;
    }

    setError("");
    setLogs([]);
    setRestoring(true);

    try {
      await restoreSnapshot(pod, props.snapshot.name, (msg) =>
        setLogs((prev) => [...prev, msg]),
      );
      setDone(true);
      props.onRestored();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/60">
      <div class="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-2xl shadow-2xl">
        <div class="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h3 class="text-base font-semibold">Restore Snapshot</h3>
          <Show when={!restoring()}>
            <button
              class="text-zinc-500 hover:text-zinc-300 text-sm"
              onClick={props.onClose}
            >
              {done() ? "Close" : "Cancel"}
            </button>
          </Show>
        </div>

        <div class="p-5 space-y-4">
          <Show when={!done()}>
            <div class="text-sm text-zinc-400">
              Restoring snapshot{" "}
              <span class="font-medium text-zinc-200">{props.snapshot.name}</span>{" "}
              <span class="font-mono text-xs text-zinc-600">({props.snapshot.stack})</span>
            </div>

            <div>
              <label class="text-xs text-zinc-500 block mb-1.5">
                Target Pod
                <span class="text-zinc-600"> — {props.snapshot.stack} stack</span>
              </label>
              <Show
                when={!pods.loading}
                fallback={<div class="text-xs text-zinc-500 animate-pulse">Loading pods...</div>}
              >
                <Show
                  when={targetPods().length > 0}
                  fallback={
                    <div class="text-xs text-zinc-500 border border-dashed border-zinc-800 rounded-lg p-4 text-center">
                      No running pods in {props.snapshot.stack}. Start the pod you want to restore into first.
                    </div>
                  }
                >
                  <div class="space-y-1">
                    <For each={targetPods()}>
                      {(pod) => (
                        <label class="flex items-center gap-2.5 px-3 py-2 rounded border border-zinc-800 bg-zinc-950 cursor-pointer hover:bg-zinc-800/30 transition-colors">
                          <input
                            type="radio"
                            name="target-pod"
                            checked={selectedPod() === pod.name}
                            onChange={() => setSelectedPod(pod.name)}
                            disabled={restoring()}
                            class="accent-sky-500"
                          />
                          <span class="text-sm text-zinc-300">{pod.name}</span>
                          <span class="text-xs text-zinc-600 ml-auto">{pod.container.status}</span>
                        </label>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>

            <Show when={selectedPod()}>
              <div class="text-xs text-amber-400 border border-amber-900/50 bg-amber-950/30 rounded-lg p-3">
                This overwrites the database in pod{" "}
                <span class="font-medium">{selectedPod()}</span> with snapshot{" "}
                <span class="font-medium">{props.snapshot.name}</span>. The pod's current
                data is erased and cannot be undone.
              </div>
            </Show>
          </Show>

          <Show when={error()}>
            <div class="text-sm text-red-400">{error()}</div>
          </Show>

          <Show when={logs().length > 0}>
            <div class="border border-zinc-800 rounded-lg bg-zinc-950 p-3 max-h-64 overflow-auto font-mono text-xs">
              <For each={logs()}>
                {(line) => <div class="py-0.5 text-zinc-500">{line}</div>}
              </For>
            </div>
          </Show>

          <Show when={done()}>
            <div class="text-sm text-emerald-400">
              Snapshot restored to {selectedPod()}.
            </div>
          </Show>

          <Show when={!done()}>
            <div class="flex justify-end pt-2">
              <button
                class="px-4 py-2 text-sm rounded-lg bg-sky-900/50 text-sky-300 hover:bg-sky-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={submit}
                disabled={restoring() || !selectedPod()}
              >
                {restoring() ? "Restoring..." : "Restore Snapshot"}
              </button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
