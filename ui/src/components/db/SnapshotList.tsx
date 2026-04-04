import { createResource, For, Show } from "solid-js";
import { fetchSnapshots } from "../../api";

export function SnapshotList() {
  const [snapshots, { refetch }] = createResource(fetchSnapshots, { initialValue: [] });

  return (
    <div>
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-semibold">Database Snapshots</h2>
        <button
          class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          onClick={() => refetch()}
        >
          Refresh
        </button>
      </div>

      <Show when={!snapshots.loading} fallback={
        <div class="text-sm text-zinc-500 animate-pulse">Loading snapshots...</div>
      }>
        <Show
          when={snapshots()!.length > 0}
          fallback={
            <div class="text-sm text-zinc-500 border border-dashed border-zinc-800 rounded-lg p-8 text-center">
              No snapshots found. Create one with{" "}
              <code class="text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">
                isopod db save &lt;pod&gt; &lt;name&gt;
              </code>
            </div>
          }
        >
          <div class="border border-zinc-800 rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-zinc-900 text-zinc-500 text-xs uppercase tracking-wider">
                  <th class="text-left px-4 py-2.5 font-medium">Name</th>
                  <th class="text-left px-4 py-2.5 font-medium">Volume</th>
                  <th class="text-right px-4 py-2.5 font-medium">Created</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-zinc-800/50">
                <For each={snapshots()}>
                  {(snap) => (
                    <tr class="hover:bg-zinc-800/30 transition-colors">
                      <td class="px-4 py-2.5 font-medium text-zinc-200">{snap.name}</td>
                      <td class="px-4 py-2.5 font-mono text-xs text-zinc-500">{snap.volume}</td>
                      <td class="px-4 py-2.5 text-right text-zinc-400">{snap.created}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
    </div>
  );
}
