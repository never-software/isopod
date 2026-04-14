import { createSignal, createEffect, For, Show, onMount } from "solid-js";
import { fetchLogs, clearLogs } from "../../api";
import { createPolledResource } from "../../lib/poll";

export function ActivityLog() {
  const [filter, setFilter] = createSignal("");
  const [logs, refetch] = createPolledResource(() => fetchLogs(500), { lines: [] });

  let scrollRef!: HTMLDivElement;
  const [latched, setLatched] = createSignal(true);

  const filteredLines = () => {
    const f = filter().toLowerCase();
    if (!f) return logs()!.lines;
    return logs()!.lines.filter((line) => line.toLowerCase().includes(f));
  };

  function isAtBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  }

  function scrollToBottom() {
    scrollRef.scrollTop = scrollRef.scrollHeight;
  }

  onMount(() => scrollToBottom());

  createEffect(() => {
    filteredLines();
    if (latched()) {
      queueMicrotask(scrollToBottom);
    }
  });

  async function handleClear() {
    await clearLogs();
    refetch();
  }

  return (
    <div class="flex flex-col flex-1 min-h-0">
      <div class="flex gap-2 mb-3">
        <input
          type="text"
          placeholder="Filter log lines..."
          class="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <button
          class="px-3 py-1.5 text-xs rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300 transition-colors"
          onClick={handleClear}
        >
          Clear Logs
        </button>
      </div>

      <div
        ref={scrollRef}
        class="border border-zinc-800 rounded-lg bg-zinc-950 p-3 flex-1 min-h-0 overflow-auto font-mono text-xs"
        onScroll={(e) => setLatched(isAtBottom(e.currentTarget))}
      >
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
