import { createResource, For, Show, createSignal, onCleanup } from "solid-js";
import { fetchCollections, fetchDaemon, fetchLogs, fetchWatchTargets, daemonStart, daemonStop, deleteCollectionApi, deleteAllCollections, toggleWatchTarget, toggleWatchPod } from "../../api";
import type { Collection, WatchTarget } from "../../types";
import { ActivityLog } from "./ActivityLog";

export function IndexerOverview() {
  const [collections, { refetch: refetchCollections }] = createResource(fetchCollections, { initialValue: [] });
  const [daemon, { refetch: refetchDaemon }] = createResource(fetchDaemon, { initialValue: { running: false, pid: null } });
  const [watchTargets, { refetch: refetchTargets }] = createResource(fetchWatchTargets, { initialValue: [] });
  const [tab, setTab] = createSignal<"collections" | "activity" | "targets">("collections");
  const [daemonLoading, setDaemonLoading] = createSignal(false);

  // Auto-refresh everything every 5s
  const interval = setInterval(() => {
    refetchDaemon();
    refetchCollections();
    refetchTargets();
  }, 5000);
  onCleanup(() => clearInterval(interval));

  // Derive stats
  const totalPoints = () => collections()!.reduce((sum, c) => sum + c.points, 0);
  const sortedCollections = () =>
    [...collections()!].sort((a, b) => {
      const aBase = a.name.endsWith("-base");
      const bBase = b.name.endsWith("-base");
      if (aBase !== bBase) return aBase ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  async function toggleDaemon() {
    setDaemonLoading(true);
    try {
      if (daemon()?.running) {
        await daemonStop();
      } else {
        await daemonStart();
      }
      // Give the process a moment to start/stop
      setTimeout(() => {
        refetchDaemon();
        setDaemonLoading(false);
      }, 1000);
    } catch (e) {
      console.error(e);
      setDaemonLoading(false);
    }
  }

  return (
    <div class="flex flex-col flex-1 min-h-0">
      <h2 class="text-xl font-semibold mb-6">Indexer</h2>

      {/* Stats cards */}
      <div class="grid grid-cols-4 gap-3 mb-6">
        <DaemonCard
          running={daemon()?.running ?? false}
          pid={daemon()?.pid ?? null}
          loading={daemonLoading()}
          onToggle={toggleDaemon}
        />
        <StatCard label="Collections" value={String(collections()!.length)} accent="cyan" />
        <StatCard label="Total Chunks" value={totalPoints().toLocaleString()} accent="cyan" />
        <StatCard label="Watch Targets" value={String(watchTargets()!.length)} accent="cyan" />
      </div>

      {/* Tab navigation */}
      <div class="flex gap-1 mb-4 border-b border-zinc-800">
        <TabButton active={tab() === "collections"} onClick={() => setTab("collections")}>
          Collections
        </TabButton>
        <TabButton active={tab() === "activity"} onClick={() => setTab("activity")}>
          Activity
        </TabButton>
        <TabButton active={tab() === "targets"} onClick={() => setTab("targets")}>
          Watch Targets
        </TabButton>
      </div>

      {/* Tab content */}
      <div class="flex-1 min-h-0 flex flex-col overflow-auto">
        <Show when={tab() === "collections"}>
          <CollectionTable collections={sortedCollections()} onRefresh={refetchCollections} />
        </Show>
        <Show when={tab() === "activity"}>
          <ActivityLog />
        </Show>
        <Show when={tab() === "targets"}>
          <WatchTargetsList targets={watchTargets()!} onRefresh={refetchTargets} />
        </Show>
      </div>
    </div>
  );
}

function DaemonCard(props: { running: boolean; pid: number | null; loading: boolean; onToggle: () => void }) {
  return (
    <div class="border border-zinc-800 rounded-lg bg-zinc-900/50 p-3">
      <div class="flex items-center justify-between mb-1">
        <div class="text-xs text-zinc-500">Daemon</div>
        <button
          class={`px-2 py-0.5 text-xs rounded transition-colors disabled:opacity-50 ${
            props.running
              ? "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
              : "bg-emerald-900/50 text-emerald-400 hover:bg-emerald-900"
          }`}
          onClick={props.onToggle}
          disabled={props.loading}
        >
          {props.loading ? "..." : props.running ? "Stop" : "Start"}
        </button>
      </div>
      <div class={`text-lg font-semibold ${props.running ? "text-emerald-400" : "text-zinc-400"}`}>
        {props.running ? "Running" : "Stopped"}
      </div>
      <Show when={props.pid}>
        <div class="text-xs text-zinc-600 font-mono mt-0.5">PID {props.pid}</div>
      </Show>
    </div>
  );
}

function StatCard(props: { label: string; value: string; accent: string }) {
  const accentClass = () =>
    props.accent === "emerald" ? "text-emerald-400" : props.accent === "cyan" ? "text-cyan-400" : "text-zinc-400";

  return (
    <div class="border border-zinc-800 rounded-lg bg-zinc-900/50 p-3">
      <div class="text-xs text-zinc-500 mb-1">{props.label}</div>
      <div class={`text-lg font-semibold ${accentClass()}`}>{props.value}</div>
    </div>
  );
}

function TabButton(props: { active: boolean; onClick: () => void; children: any }) {
  return (
    <button
      class={`px-3 py-2 text-sm transition-colors border-b-2 -mb-px ${
        props.active
          ? "border-cyan-500 text-zinc-100"
          : "border-transparent text-zinc-500 hover:text-zinc-300"
      }`}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function CollectionTable(props: { collections: Collection[]; onRefresh: () => void }) {
  const [deleting, setDeleting] = createSignal<string | null>(null);

  async function handleDelete(name: string) {
    if (!confirm(`Delete collection "${name}"?`)) return;
    setDeleting(name);
    try {
      await deleteCollectionApi(name);
      props.onRefresh();
    } finally {
      setDeleting(null);
    }
  }

  async function handleDeleteAll() {
    if (!confirm(`Delete all ${props.collections.length} collections? This cannot be undone.`)) return;
    setDeleting("__all__");
    try {
      await deleteAllCollections();
      props.onRefresh();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <Show
      when={props.collections.length > 0}
      fallback={<div class="text-sm text-zinc-500">No collections found.</div>}
    >
      <div class="flex justify-end mb-2">
        <button
          class="px-2.5 py-1 text-xs rounded bg-red-900/30 text-red-400 hover:bg-red-900/50 transition-colors disabled:opacity-50"
          onClick={handleDeleteAll}
          disabled={deleting() !== null}
        >
          {deleting() === "__all__" ? "Deleting..." : "Delete All"}
        </button>
      </div>
      <div class="border border-zinc-800 rounded-lg overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-zinc-900 text-zinc-500 text-xs uppercase tracking-wider">
              <th class="text-left px-4 py-2.5 font-medium">Collection</th>
              <th class="text-left px-4 py-2.5 font-medium">Type</th>
              <th class="text-right px-4 py-2.5 font-medium">Chunks</th>
              <th class="w-16"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-zinc-800/50">
            <For each={props.collections}>
              {(col) => {
                const isBase = col.name.endsWith("-base");
                return (
                  <tr class="hover:bg-zinc-800/30 transition-colors group">
                    <td class="px-4 py-2.5 font-mono text-xs">{col.name}</td>
                    <td class="px-4 py-2.5">
                      <span
                        class={`text-xs px-1.5 py-0.5 rounded ${
                          isBase
                            ? "bg-cyan-900/30 text-cyan-400"
                            : "bg-violet-900/30 text-violet-400"
                        }`}
                      >
                        {isBase ? "base" : "pod"}
                      </span>
                    </td>
                    <td class="px-4 py-2.5 text-right font-mono text-zinc-400">
                      {col.points.toLocaleString()}
                    </td>
                    <td class="px-4 py-2.5 text-right">
                      <button
                        class="text-xs text-red-400/70 hover:text-red-400 transition-colors disabled:opacity-50"
                        onClick={() => handleDelete(col.name)}
                        disabled={deleting() !== null}
                      >
                        {deleting() === col.name ? "..." : "Delete"}
                      </button>
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}

function WatchTargetsList(props: { targets: WatchTarget[]; onRefresh: () => void }) {
  const baseTargets = () => props.targets.filter((t) => !t.podName);
  const podTargets = () => props.targets.filter((t) => t.podName);

  const podGroups = () => {
    const groups = new Map<string, WatchTarget[]>();
    for (const t of podTargets()) {
      const list = groups.get(t.podName!) || [];
      list.push(t);
      groups.set(t.podName!, list);
    }
    return groups;
  };

  async function handleToggle(collectionName: string) {
    await toggleWatchTarget(collectionName);
    props.onRefresh();
  }

  async function handleTogglePod(podName: string, currentlyAllEnabled: boolean) {
    await toggleWatchPod(podName, !currentlyAllEnabled);
    props.onRefresh();
  }

  return (
    <div class="space-y-4">
      <Show when={baseTargets().length > 0}>
        <div>
          <div class="flex items-center justify-between px-3 py-2 mb-1">
            <h4 class="text-xs uppercase tracking-wider text-zinc-500">Base Repos</h4>
          </div>
          <div class="space-y-1">
            <For each={baseTargets()}>
              {(t) => <TargetRow target={t} onToggle={() => handleToggle(t.collectionName)} />}
            </For>
          </div>
        </div>
      </Show>

      <For each={Array.from(podGroups().entries())}>
        {([podName, targets]) => {
          const allEnabled = () => targets.every((t) => t.enabled);
          const noneEnabled = () => targets.every((t) => !t.enabled);
          return (
            <div>
              <div class={`flex items-center justify-between border border-zinc-800 rounded px-3 py-2 transition-colors ${
                noneEnabled() ? "bg-zinc-900/20 opacity-60" : "bg-zinc-900/30"
              } ${noneEnabled() ? "" : "mb-1"}`}>
                <h4 class="text-xs uppercase tracking-wider text-zinc-500">
                  Pod: <span class="text-zinc-400">{podName}</span>
                  <Show when={noneEnabled()}>
                    <span class="text-zinc-600 ml-2 normal-case tracking-normal">{targets.length} repos</span>
                  </Show>
                </h4>
                <Toggle enabled={allEnabled()} onToggle={() => handleTogglePod(podName, allEnabled())} />
              </div>
              <Show when={!noneEnabled()}>
                <div class="space-y-1">
                  <For each={targets}>
                    {(t) => <TargetRow target={t} onToggle={() => handleToggle(t.collectionName)} />}
                  </For>
                </div>
              </Show>
            </div>
          );
        }}
      </For>

      <Show when={props.targets.length === 0}>
        <div class="text-sm text-zinc-500">No watch targets found.</div>
      </Show>
    </div>
  );
}

function TargetRow(props: { target: WatchTarget; onToggle: () => void }) {
  return (
    <div class={`flex items-center justify-between text-xs border border-zinc-800 rounded px-3 py-2 transition-colors ${
      props.target.enabled ? "bg-zinc-900/50" : "bg-zinc-900/20 opacity-60"
    }`}>
      <div class="flex items-center gap-2">
        <span class={`font-medium ${props.target.enabled ? "text-zinc-300" : "text-zinc-500"}`}>
          {props.target.repoName}
        </span>
        <span class="font-mono text-zinc-600 truncate">{props.target.collectionName}</span>
      </div>
      <Toggle enabled={props.target.enabled} onToggle={props.onToggle} />
    </div>
  );
}

function Toggle(props: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      class={`w-8 h-4 rounded-full relative transition-colors flex-shrink-0 ${
        props.enabled ? "bg-emerald-600" : "bg-zinc-700"
      }`}
      onClick={props.onToggle}
    >
      <span class={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
        props.enabled ? "left-4" : "left-0.5"
      }`} />
    </button>
  );
}
