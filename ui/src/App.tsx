import { createSignal, Match, Switch } from "solid-js";
import type { View } from "./types";
import { Sidebar } from "./components/layout/Sidebar";
import { PodList } from "./components/pods/PodList";
import { IndexerOverview } from "./components/indexer/IndexerOverview";
import { SnapshotList } from "./components/db/SnapshotList";

const VIEWS: View[] = ["pods", "indexer", "database"];

function getInitialView(): View {
  const hash = location.hash.slice(1);
  return VIEWS.includes(hash as View) ? (hash as View) : "pods";
}

export default function App() {
  const [view, setView] = createSignal<View>(getInitialView());

  function navigate(v: View) {
    location.hash = v;
    setView(v);
  }

  return (
    <div class="flex h-screen bg-zinc-950 text-zinc-100">
      <Sidebar current={view()} onNavigate={navigate} />
      <main class="flex-1 flex flex-col overflow-hidden p-6">
        <Switch>
          <Match when={view() === "pods"}>
            <PodList />
          </Match>
          <Match when={view() === "indexer"}>
            <IndexerOverview />
          </Match>
<Match when={view() === "database"}>
            <SnapshotList />
          </Match>
        </Switch>
      </main>
    </div>
  );
}
