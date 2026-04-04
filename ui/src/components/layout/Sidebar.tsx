import { createResource } from "solid-js";
import type { View } from "../../types";
import { fetchDaemon } from "../../api";

interface Props {
  current: View;
  onNavigate: (view: View) => void;
}

const NAV_ITEMS: { view: View; label: string; icon: string }[] = [
  { view: "pods", label: "Pods", icon: "cube" },
  { view: "indexer", label: "Indexer", icon: "chart" },
  { view: "database", label: "Database", icon: "database" },
];

const ICONS: Record<string, () => any> = {
  cube: () => (
    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
    </svg>
  ),
  chart: () => (
    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  ),
  search: () => (
    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  ),
  database: () => (
    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
    </svg>
  ),
};

export function Sidebar(props: Props) {
  const [daemon, { refetch }] = createResource(fetchDaemon, { initialValue: { running: false, pid: null } });

  // Re-poll daemon status every 5s
  setInterval(() => refetch(), 5000);

  return (
    <aside class="w-56 border-r border-zinc-800 bg-zinc-900 flex flex-col">
      {/* Logo */}
      <div class="px-4 py-4 border-b border-zinc-800">
        <h1 class="text-lg font-semibold tracking-tight text-zinc-100">isopod</h1>
      </div>

      {/* Navigation */}
      <nav class="flex-1 px-2 py-3 space-y-0.5">
        {NAV_ITEMS.map((item) => (
          <button
            class={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
              props.current === item.view
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
            }`}
            onClick={() => props.onNavigate(item.view)}
          >
            {ICONS[item.icon]()}
            {item.label}
          </button>
        ))}
      </nav>

      {/* Daemon status */}
      <div class="px-4 py-3 border-t border-zinc-800">
        <div class="flex items-center gap-2 text-xs">
          <span
            class={`w-2 h-2 rounded-full ${
              daemon()?.running ? "bg-emerald-500" : "bg-zinc-600"
            }`}
          />
          <span class="text-zinc-500">
            Daemon {daemon()?.running ? `running` : "stopped"}
          </span>
          {daemon()?.pid && (
            <span class="text-zinc-600 ml-auto font-mono">PID {daemon()!.pid}</span>
          )}
        </div>
      </div>
    </aside>
  );
}
