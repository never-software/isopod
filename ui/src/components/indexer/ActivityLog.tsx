import { createResource, createSignal, For, Show, onCleanup } from "solid-js";
import { fetchLogs } from "../../api";

export function ActivityLog() {
  const [filter, setFilter] = createSignal("");
  const [logs, { refetch }] = createResource(() => fetchLogs(500), { initialValue: { lines: [] } });

  // Auto-refresh every 5 seconds
  const interval = setInterval(() => refetch(), 5000);
  onCleanup(() => clearInterval(interval));

  const filteredLines = () => {
    const f = filter().toLowerCase();
    if (!f) return logs()!.lines;
    return logs()!.lines.filter((line) => line.toLowerCase().includes(f));
  };

  return (
    <div class="flex flex-col flex-1 min-h-0">
      <div class="mb-3">
        <input
          type="text"
          placeholder="Filter log lines..."
          class="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      </div>

      <div class="border border-zinc-800 rounded-lg bg-zinc-950 p-3 flex-1 min-h-0 overflow-auto font-mono text-xs">
        <Show
          when={filteredLines().length > 0}
          fallback={<div class="text-zinc-600">No log entries.</div>}
        >
          <For each={filteredLines()}>
            {(line) => <LogLine line={line} />}
          </For>
        </Show>
      </div>
    </div>
  );
}

function LogLine(props: { line: string }) {
  const colorClass = () => {
    if (props.line.includes("Error") || props.line.includes("error"))
      return "text-red-400";
    if (props.line.includes("Indexed:"))
      return "text-emerald-400";
    if (props.line.includes("Deleted:"))
      return "text-amber-400";
    if (props.line.includes("Watching") || props.line.includes("ready"))
      return "text-cyan-400";
    return "text-zinc-500";
  };

  return (
    <div class={`py-0.5 leading-relaxed whitespace-pre-wrap break-all ${colorClass()}`}>
      {props.line}
    </div>
  );
}
