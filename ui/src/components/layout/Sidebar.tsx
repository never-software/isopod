import { createSignal, For, Show } from "solid-js";
import type { NavState, LandingSubView, StackSubView } from "../../types";
import { fetchIndexer, indexerStart, indexerStop } from "../../api";
import { createPolledResource } from "../../lib/poll";

interface Props {
  navState: NavState;
  onNavigate: (nav: NavState) => void;
  stacks: string[];
}

const LANDING_NAV: { view: LandingSubView; label: string; icon: string }[] = [
  { view: "stacks", label: "Stacks", icon: "stack" },
  { view: "base", label: "Bases", icon: "layers" },
  { view: "pods", label: "Pods", icon: "cube" },
  { view: "indexes", label: "Indexes", icon: "chart" },
  { view: "snapshots", label: "Data Snapshots", icon: "database" },
  { view: "settings", label: "Settings", icon: "gear" },
];

const STACK_SUB_NAV: { view: StackSubView; label: string; icon: string }[] = [
  { view: "base", label: "Base", icon: "layers" },
  { view: "pods", label: "Pods", icon: "cube" },
  { view: "indexes", label: "Indexes", icon: "chart" },
  { view: "snapshots", label: "Data Snapshots", icon: "database" },
  { view: "settings", label: "Settings", icon: "gear" },
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
  layers: () => (
    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0l-5.571 3-5.571-3" />
    </svg>
  ),
  database: () => (
    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
    </svg>
  ),
  gear: () => (
    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  stack: () => (
    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7" />
    </svg>
  ),
};

export function Sidebar(props: Props) {
  const [indexer, refetch] = createPolledResource(fetchIndexer, { running: false, pid: null });
  const [toggling, setToggling] = createSignal(false);

  async function toggleIndexer() {
    setToggling(true);
    try {
      if (indexer()?.running) await indexerStop();
      else await indexerStart();
      setTimeout(() => { refetch(); setToggling(false); }, 1000);
    } catch { setToggling(false); }
  }

  const isStackMode = () => props.navState.mode === "stack";
  const currentStack = () => isStackMode() ? (props.navState as { stack: string }).stack : null;
  const currentSubView = () => props.navState.subView;
  const currentLandingView = () => props.navState.mode === "landing" ? props.navState.subView : null;

  return (
    <aside class="w-56 border-r border-zinc-800 bg-zinc-900 flex flex-col">
      {/* Logo */}
      <div class="px-4 py-4 border-b border-zinc-800">
        <h1 class="text-lg font-semibold tracking-tight text-zinc-100">isopod</h1>
      </div>

      {/* Navigation */}
      <nav class="flex-1 px-2 py-3 space-y-0.5">
        <Show
          when={isStackMode()}
          fallback={
            /* Landing mode: cross-stack nav */
            <For each={LANDING_NAV}>
              {(item) => (
                <button
                  class={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                    currentLandingView() === item.view
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                  }`}
                  onClick={() => props.onNavigate({ mode: "landing", subView: item.view })}
                >
                  {ICONS[item.icon]()}
                  {item.label}
                </button>
              )}
            </For>
          }
        >
          {/* Stack-scoped mode: back button + sub-nav */}
          <button
            class="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-1"
            onClick={() => props.onNavigate({ mode: "landing", subView: "stacks" })}
          >
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
            All Stacks
          </button>
          <div class="px-3 py-1.5 text-xs font-medium text-zinc-500 uppercase tracking-wider">
            {currentStack()}
          </div>
          <For each={STACK_SUB_NAV}>
            {(item) => (
              <button
                class={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                  currentSubView() === item.view
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                }`}
                onClick={() => props.onNavigate({ mode: "stack", stack: currentStack()!, subView: item.view })}
              >
                {ICONS[item.icon]()}
                {item.label}
              </button>
            )}
          </For>
        </Show>
      </nav>

      {/* Indexer status */}
      <div class="px-4 py-3 border-t border-zinc-800">
        <div class="flex items-center gap-2 text-xs">
          <span
            class={`w-2 h-2 rounded-full ${
              indexer()?.running ? "bg-emerald-500" : "bg-zinc-600"
            }`}
          />
          <span class="text-zinc-500 flex-1">
            Indexer {indexer()?.running ? "running" : "stopped"}
          </span>
          <button
            class={`px-1.5 py-0.5 text-xs rounded transition-colors disabled:opacity-50 ${
              indexer()?.running
                ? "text-zinc-500 hover:text-zinc-300"
                : "text-emerald-500 hover:text-emerald-400"
            }`}
            onClick={toggleIndexer}
            disabled={toggling()}
          >
            {toggling() ? "..." : indexer()?.running ? "Stop" : "Start"}
          </button>
        </div>
      </div>
    </aside>
  );
}
