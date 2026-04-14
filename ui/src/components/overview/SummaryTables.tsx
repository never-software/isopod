import { createResource, For, Show } from "solid-js";
import { fetchPods, fetchCollections, fetchSnapshots, fetchCache } from "../../api";

// ── Pods Summary ────────────────────────────────────────────────────

export function PodsSummary() {
  const [pods] = createResource(fetchPods, { initialValue: [] });

  return (
    <div>
      <h2 class="text-xl font-semibold mb-6">Pods</h2>
      <Show when={pods()!.length > 0} fallback={<Empty text="No pods" />}>
        <Table
          headers={["Name", "Stack", "Status"]}
          rows={pods()!}
          row={(pod) => [
            <span class="font-medium text-zinc-200">{pod.name}</span>,
            <span class="text-zinc-400">{pod.stack}</span>,
            <div class="flex items-center gap-2">
              <span class={`w-1.5 h-1.5 rounded-full ${pod.container.state === "running" ? "bg-emerald-500" : "bg-zinc-600"}`} />
              <span class="text-zinc-400">{pod.container.status || pod.container.state}</span>
            </div>,
          ]}
        />
      </Show>
    </div>
  );
}

// ── Indexer Summary ─────────────────────────────────────────────────

export function IndexerSummary() {
  const [collections] = createResource(fetchCollections, { initialValue: [] });

  return (
    <div>
      <h2 class="text-xl font-semibold mb-6">Indexer</h2>
      <Show when={collections()!.length > 0} fallback={<Empty text="No collections" />}>
        <Table
          headers={["Collection", "Points"]}
          rows={collections()!}
          row={(c) => [
            <span class="font-medium text-zinc-200">{c.name}</span>,
            <span class="font-mono text-zinc-400">{c.points.toLocaleString()}</span>,
          ]}
        />
      </Show>
    </div>
  );
}

// ── Database Summary ────────────────────────────────────────────────

export function DatabaseSummary() {
  const [snapshots] = createResource(fetchSnapshots, { initialValue: [] });

  return (
    <div>
      <h2 class="text-xl font-semibold mb-6">Database Snapshots</h2>
      <Show when={snapshots()!.length > 0} fallback={<Empty text="No snapshots" />}>
        <Table
          headers={["Name", "Volume", "Created"]}
          rows={snapshots()!}
          row={(s) => [
            <span class="font-medium text-zinc-200">{s.name}</span>,
            <span class="font-mono text-xs text-zinc-500">{s.volume}</span>,
            <span class="text-zinc-400">{s.created}</span>,
          ]}
        />
      </Show>
    </div>
  );
}

// ── Cache Summary ───────────────────────────────────────────────────

export function CacheSummary(props: { stacks: string[] }) {
  return (
    <div>
      <h2 class="text-xl font-semibold mb-6">Base Image</h2>
      <Show when={props.stacks.length > 0} fallback={<Empty text="No stacks" />}>
        <div class="space-y-6">
          <For each={props.stacks}>
            {(stack) => <CacheStackSection stack={stack} />}
          </For>
        </div>
      </Show>
    </div>
  );
}

function CacheStackSection(props: { stack: string }) {
  const [cache] = createResource(
    () => props.stack,
    (s) => fetchCache(s)
  );

  const layers = () => cache()?.layers ?? [];

  return (
    <div>
      <h3 class="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">{props.stack}</h3>
      <Show when={cache.state !== "pending" && cache.state !== "unresolved"} fallback={<div class="text-sm text-zinc-500 animate-pulse">Loading...</div>}>
        <Show when={layers().length > 0} fallback={<div class="text-xs text-zinc-600 mb-2">No layers</div>}>
          <Table
            headers={["Layer", "Status", "Version"]}
            rows={layers()}
            row={(l) => [
              <span class="font-medium text-zinc-200">{l.name}</span>,
              <div class="flex items-center gap-2">
                <span class={`w-1.5 h-1.5 rounded-full ${
                  l.status === "fresh" ? "bg-emerald-500" : l.status === "stale" ? "bg-amber-500" : "bg-zinc-600"
                }`} />
                <span class={
                  l.status === "fresh" ? "text-emerald-400" : l.status === "stale" ? "text-amber-400" : "text-zinc-500"
                }>{l.status}</span>
              </div>,
              <span class="font-mono text-xs text-zinc-400">{l.version}</span>,
            ]}
          />
        </Show>
      </Show>
    </div>
  );
}

// ── Shared ──────────────────────────────────────────────────────────

function Table<T>(props: { headers: string[]; rows: T[]; row: (item: T) => any[] }) {
  return (
    <div class="border border-zinc-800 rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-zinc-900 text-zinc-500 text-xs uppercase tracking-wider">
            <For each={props.headers}>
              {(h) => <th class="text-left px-4 py-2.5 font-medium">{h}</th>}
            </For>
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-800/50">
          <For each={props.rows}>
            {(item) => (
              <tr class="hover:bg-zinc-800/30 transition-colors">
                <For each={props.row(item)}>
                  {(cell) => <td class="px-4 py-2.5 text-sm">{cell}</td>}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

function Empty(props: { text: string }) {
  return (
    <div class="text-sm text-zinc-500 border border-dashed border-zinc-800 rounded-lg p-8 text-center">
      {props.text}
    </div>
  );
}
