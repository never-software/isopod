import { createResource, createSignal, For, Show } from "solid-js";
import { fetchCache, deleteCacheLayer, destroyCache } from "../../api";
import type { LayerInfo } from "../../types";

const STATUS_STYLES: Record<LayerInfo["status"], { dot: string; text: string }> = {
  fresh: { dot: "bg-emerald-500", text: "text-emerald-400" },
  stale: { dot: "bg-amber-500", text: "text-amber-400" },
  "not built": { dot: "bg-zinc-600", text: "text-zinc-500" },
};

export function CacheOverview() {
  const [cache, { refetch }] = createResource(fetchCache);
  const [deleting, setDeleting] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  function toggleExpand(name: string) {
    const next = new Set(expanded());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpanded(next);
  }

  function isExpanded(name: string) {
    return expanded().has(name);
  }

  const isDAG = () => cache()?.isDAG ?? false;

  /** Build tree connector prefix for each layer in DAG mode */
  function treePrefix(layers: LayerInfo[]): Map<string, string> {
    const prefixes = new Map<string, string>();
    // Group children by parent
    const childrenOf = new Map<string | undefined, LayerInfo[]>();
    for (const layer of layers) {
      const parent = layer.from;
      const list = childrenOf.get(parent) || [];
      list.push(layer);
      childrenOf.set(parent, list);
    }

    function walk(layer: LayerInfo, prefix: string, connector: string) {
      prefixes.set(layer.name, prefix + connector);
      const children = childrenOf.get(layer.name) || [];
      children.forEach((child, i) => {
        const isLast = i === children.length - 1;
        const nextPrefix = prefix + (connector ? (connector.startsWith("\u2514") ? "   " : "\u2502  ") : "");
        const childConnector = isLast ? "\u2514\u2500 " : "\u251C\u2500 ";
        walk(child, nextPrefix, childConnector);
      });
    }

    const roots = childrenOf.get(undefined) || [];
    for (const root of roots) {
      walk(root, "", "");
    }
    return prefixes;
  }

  type Row =
    | { kind: "layer"; layer: LayerInfo; index: number }
    | { kind: "content"; layer: LayerInfo };

  const rows = (): Row[] => {
    const layers = cache()?.layers ?? [];
    const exp = expanded();
    const result: Row[] = [];
    if (isDAG()) {
      // In DAG mode, emit layers in tree order (DFS) instead of flat order
      const childrenOf = new Map<string | undefined, LayerInfo[]>();
      for (const layer of layers) {
        const parent = layer.from;
        const list = childrenOf.get(parent) || [];
        list.push(layer);
        childrenOf.set(parent, list);
      }
      let idx = 0;
      function walkRows(layer: LayerInfo) {
        result.push({ kind: "layer", layer, index: idx++ });
        if (exp.has(layer.name) && layer.content.length > 0) {
          result.push({ kind: "content", layer });
        }
        for (const child of childrenOf.get(layer.name) || []) {
          walkRows(child);
        }
      }
      for (const root of childrenOf.get(undefined) || []) {
        walkRows(root);
      }
    } else {
      layers.forEach((layer, i) => {
        result.push({ kind: "layer", layer, index: i });
        if (exp.has(layer.name) && layer.content.length > 0) {
          result.push({ kind: "content", layer });
        }
      });
    }
    return result;
  };

  const treePrefixes = () => {
    const layers = cache()?.layers ?? [];
    return isDAG() ? treePrefix(layers) : new Map<string, string>();
  };

  async function handleInvalidate(layer: string) {
    setDeleting(layer);
    try {
      await deleteCacheLayer(layer);
      refetch();
    } finally {
      setDeleting(null);
    }
  }

  async function handleDestroy() {
    if (!confirm("Destroy cache? This removes the workspace image and all stored hashes.")) return;
    setDeleting("__destroy__");
    try {
      await destroyCache();
      refetch();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div>
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-semibold">Cache Layers</h2>
        <button
          class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          onClick={() => refetch()}
        >
          Refresh
        </button>
      </div>

      <Show when={!cache.loading} fallback={
        <div class="text-sm text-zinc-500 animate-pulse">Loading cache info...</div>
      }>
        {/* Image info card */}
        <Show when={cache()}>
          {(c) => (
            <div class="mb-6 border border-zinc-800 rounded-lg bg-zinc-900/50 p-4">
              <div class="flex items-center gap-3">
                <span class={`w-2 h-2 rounded-full ${c().image.exists ? "bg-emerald-500" : "bg-zinc-600"}`} />
                <span class="text-sm font-medium text-zinc-200">
                  {c().image.name}
                </span>
                <Show when={!c().image.exists}>
                  <span class="text-xs text-zinc-500">not built</span>
                </Show>
                <Show when={c().image.exists}>
                  <div class="flex items-center gap-4 text-xs text-zinc-500">
                    <Show when={c().image.sizeMB}>
                      <span>Size: <span class="text-zinc-400">{c().image.sizeMB} MB</span></span>
                    </Show>
                    <Show when={c().image.created}>
                      <span>Built: <span class="text-zinc-400">{c().image.created}</span></span>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
          )}
        </Show>

        {/* Layer table */}
        <Show when={cache()?.layers && cache()!.layers.length > 0}>
          <div class="flex justify-end mb-2">
            <button
              class="px-2.5 py-1 text-xs rounded bg-red-900/30 text-red-400 hover:bg-red-900/50 transition-colors disabled:opacity-50"
              onClick={handleDestroy}
              disabled={deleting() !== null}
            >
              {deleting() === "__destroy__" ? "Destroying..." : "Destroy All"}
            </button>
          </div>
          <div class="border border-zinc-800 rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-zinc-900 text-zinc-500 text-xs uppercase tracking-wider">
                  <Show when={!isDAG()}>
                    <th class="text-left px-4 py-2.5 font-medium w-8">#</th>
                  </Show>
                  <th class="text-left px-4 py-2.5 font-medium">Layer</th>
                  <th class="text-left px-4 py-2.5 font-medium">Status</th>
                  <th class="text-left px-4 py-2.5 font-medium">Current</th>
                  <th class="text-left px-4 py-2.5 font-medium">Stored</th>
                  <th class="w-16"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-zinc-800/50">
                <For each={rows()}>
                  {(row) => {
                    if (row.kind === "content") {
                      return (
                        <tr class="bg-zinc-950">
                          <td class="py-0" colspan={isDAG() ? 5 : 6}>
                            <pre class="px-10 py-3 text-xs font-mono text-zinc-400 overflow-x-auto whitespace-pre-wrap">{row.layer.content.join("\n")}</pre>
                          </td>
                        </tr>
                      );
                    }
                    const { layer, index } = row;
                    const style = STATUS_STYLES[layer.status];
                    const prefix = treePrefixes().get(layer.name) || "";
                    return (
                      <tr
                        class={`hover:bg-zinc-800/30 transition-colors cursor-pointer ${isExpanded(layer.name) ? "bg-zinc-800/20" : ""}`}
                        onClick={() => toggleExpand(layer.name)}
                      >
                        <Show when={!isDAG()}>
                          <td class="px-4 py-2.5 text-zinc-600 font-mono text-xs">{index + 1}</td>
                        </Show>
                        <td class="px-4 py-2.5 font-medium text-zinc-200">
                          <span class="flex items-center gap-2">
                            <Show when={isDAG() && prefix}>
                              <span class="font-mono text-zinc-600 whitespace-pre">{prefix}</span>
                            </Show>
                            <svg class={`w-3 h-3 text-zinc-500 transition-transform flex-shrink-0 ${isExpanded(layer.name) ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                              <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                            </svg>
                            <span>
                              {layer.name}
                              <Show when={isDAG() && layer.needs && layer.needs.length > 0}>
                                <span class="block text-xs text-zinc-600 font-normal">needs: {layer.needs!.join(", ")}</span>
                              </Show>
                            </span>
                          </span>
                        </td>
                        <td class="px-4 py-2.5">
                          <div class="flex items-center gap-2">
                            <span class={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                            <span class={`text-xs ${style.text}`}>{layer.status}</span>
                          </div>
                        </td>
                        <td class="px-4 py-2.5 font-mono text-xs text-zinc-400">{layer.version}</td>
                        <td class="px-4 py-2.5 font-mono text-xs text-zinc-500">
                          {layer.storedVersion || "\u2014"}
                        </td>
                        <td class="px-4 py-2.5 text-right">
                          <Show when={layer.status === "fresh"}>
                            <button
                              class="text-xs text-red-400/70 hover:text-red-400 transition-colors disabled:opacity-50"
                              onClick={(e: MouseEvent) => { e.stopPropagation(); handleInvalidate(layer.name); }}
                              disabled={deleting() !== null}
                            >
                              {deleting() === layer.name ? "..." : "Invalidate"}
                            </button>
                          </Show>
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        {/* Summary */}
        <Show when={cache()?.layers}>
          {(layers) => {
            const fresh = () => layers().filter((l) => l.status === "fresh").length;
            const stale = () => layers().filter((l) => l.status === "stale").length;
            const notBuilt = () => layers().filter((l) => l.status === "not built").length;
            return (
              <div class="mt-4 flex gap-4 text-xs text-zinc-500">
                <span><span class="text-emerald-400">{fresh()}</span> fresh</span>
                <Show when={stale() > 0}>
                  <span><span class="text-amber-400">{stale()}</span> stale</span>
                </Show>
                <Show when={notBuilt() > 0}>
                  <span><span class="text-zinc-400">{notBuilt()}</span> not built</span>
                </Show>
              </div>
            );
          }}
        </Show>
      </Show>
    </div>
  );
}
