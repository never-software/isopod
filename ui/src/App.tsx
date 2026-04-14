import { createSignal, createResource, onCleanup, Match, Switch } from "solid-js";
import type { NavState, LandingSubView, StackSubView } from "./types";
import { fetchStacks } from "./api";
import { Sidebar } from "./components/layout/Sidebar";
import { PodList } from "./components/pods/PodList";
import { IndexerOverview } from "./components/indexer/IndexerOverview";
import { SnapshotList } from "./components/db/SnapshotList";
import { CacheOverview } from "./components/cache/CacheOverview";
import { SettingsOverview } from "./components/settings/SettingsOverview";
import { StacksOverview } from "./components/stacks/StacksOverview";
import { PodsSummary, DatabaseSummary, CacheSummary } from "./components/overview/SummaryTables";

const LANDING_SUBS: LandingSubView[] = ["stacks", "pods", "indexes", "snapshots", "base", "settings"];
const STACK_SUBS: StackSubView[] = ["pods", "indexes", "snapshots", "base", "settings"];

function parseHash(): NavState {
  const raw = location.hash.slice(1);
  if (!raw) return { mode: "landing", subView: "stacks" };

  // Landing views: #stacks, #pods, #indexer, #database, #cache
  if (LANDING_SUBS.includes(raw as LandingSubView)) {
    return { mode: "landing", subView: raw as LandingSubView };
  }

  // Stack-scoped views: #<stack>/<subview>
  const slash = raw.indexOf("/");
  if (slash === -1) return { mode: "landing", subView: "stacks" };
  const stack = raw.slice(0, slash);
  const sub = raw.slice(slash + 1);
  return STACK_SUBS.includes(sub as StackSubView)
    ? { mode: "stack", stack, subView: sub as StackSubView }
    : { mode: "landing", subView: "stacks" };
}

export default function App() {
  const [navState, setNavState] = createSignal<NavState>(parseHash());
  const [stacks] = createResource(fetchStacks, { initialValue: [] });

  function navigate(nav: NavState) {
    if (nav.mode === "landing") {
      location.hash = nav.subView;
    } else {
      location.hash = `${nav.stack}/${nav.subView}`;
    }
    setNavState(nav);
  }

  // Sync state on browser back/forward
  const onHashChange = () => setNavState(parseHash());
  window.addEventListener("hashchange", onHashChange);
  onCleanup(() => window.removeEventListener("hashchange", onHashChange));

  const stackState = () => {
    const s = navState();
    return s.mode === "stack" ? s : null;
  };

  const landingState = () => {
    const s = navState();
    return s.mode === "landing" ? s : null;
  };

  return (
    <div class="flex h-screen bg-zinc-950 text-zinc-100">
      <Sidebar navState={navState()} onNavigate={navigate} stacks={stacks() || []} />
      <main class="flex-1 flex flex-col overflow-y-auto p-6">
        <Switch>
          <Match when={landingState()}>
            {(state) => (
              <Switch>
                <Match when={state().subView === "stacks"}>
                  <StacksOverview onSelectStack={(name) => navigate({ mode: "stack", stack: name, subView: "pods" })} />
                </Match>
                <Match when={state().subView === "pods"}>
                  <PodsSummary />
                </Match>
                <Match when={state().subView === "indexes"}>
                  <IndexerOverview />
                </Match>
                <Match when={state().subView === "snapshots"}>
                  <DatabaseSummary />
                </Match>
                <Match when={state().subView === "base"}>
                  <CacheSummary stacks={stacks() || []} />
                </Match>
                <Match when={state().subView === "settings"}>
                  <SettingsOverview />
                </Match>
              </Switch>
            )}
          </Match>
          <Match when={stackState()}>
            {(state) => (
              <Switch>
                <Match when={state().subView === "pods"}>
                  <PodList stack={state().stack} />
                </Match>
                <Match when={state().subView === "indexes"}>
                  <IndexerOverview stack={state().stack} />
                </Match>
                <Match when={state().subView === "snapshots"}>
                  <SnapshotList />
                </Match>
                <Match when={state().subView === "base"}>
                  <CacheOverview stack={state().stack} />
                </Match>
                <Match when={state().subView === "settings"}>
                  <SettingsOverview stack={state().stack} />
                </Match>
              </Switch>
            )}
          </Match>
        </Switch>
      </main>
    </div>
  );
}
