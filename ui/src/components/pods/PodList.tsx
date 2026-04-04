import { createResource, For, Show, createSignal } from "solid-js";
import { fetchPods, podUp, podDown } from "../../api";
import type { Pod } from "../../types";
import { CreatePodWizard } from "./CreatePodWizard";

export function PodList() {
  const [pods, { refetch }] = createResource(fetchPods, { initialValue: [] });
  const [actionPod, setActionPod] = createSignal<string | null>(null);
  const [showWizard, setShowWizard] = createSignal(false);

  async function handleAction(pod: Pod, action: "up" | "down") {
    setActionPod(pod.name);
    try {
      if (action === "up") {
        await podUp(pod.name);
      } else {
        await podDown(pod.name);
      }
      // Refresh after a delay to let container state settle
      setTimeout(() => refetch(), 2000);
    } catch (e: any) {
      console.error(e);
    } finally {
      setActionPod(null);
    }
  }

  return (
    <div>
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-semibold">Pods</h2>
        <div class="flex items-center gap-3">
          <button
            class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            onClick={() => refetch()}
          >
            Refresh
          </button>
          <button
            class="px-3 py-1.5 text-xs rounded-lg bg-emerald-900/50 text-emerald-400 hover:bg-emerald-900 transition-colors"
            onClick={() => setShowWizard(true)}
          >
            New Pod
          </button>
        </div>
      </div>

      <Show when={showWizard()}>
        <CreatePodWizard
          onClose={() => setShowWizard(false)}
          onCreated={() => refetch()}
        />
      </Show>

      <Show when={!pods.loading} fallback={<LoadingState />}>
        <Show
          when={pods()!.length > 0}
          fallback={<EmptyState />}
        >
          <div class="space-y-3">
            <For each={pods()}>
              {(pod) => (
                <PodCard
                  pod={pod}
                  loading={actionPod() === pod.name}
                  onUp={() => handleAction(pod, "up")}
                  onDown={() => handleAction(pod, "down")}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function PodCard(props: {
  pod: Pod;
  loading: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  const isRunning = () => props.pod.container.state === "running";

  return (
    <div class="border border-zinc-800 rounded-lg bg-zinc-900/50 p-4">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-3">
          <span
            class={`w-2.5 h-2.5 rounded-full ${
              isRunning() ? "bg-emerald-500" : "bg-zinc-600"
            }`}
          />
          <h3 class="font-medium">{props.pod.name}</h3>
        </div>

        <div class="flex items-center gap-2">
          <span class="text-xs text-zinc-500">
            {props.pod.container.status || props.pod.container.state}
          </span>
          <Show when={!props.loading} fallback={
            <span class="text-xs text-zinc-500 animate-pulse">working...</span>
          }>
            <Show
              when={isRunning()}
              fallback={
                <button
                  class="px-2.5 py-1 text-xs rounded bg-emerald-900/50 text-emerald-400 hover:bg-emerald-900 transition-colors"
                  onClick={props.onUp}
                >
                  Start
                </button>
              }
            >
              <button
                class="px-2.5 py-1 text-xs rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-colors"
                onClick={props.onDown}
              >
                Stop
              </button>
            </Show>
          </Show>
        </div>
      </div>

      <Show when={props.pod.repos.length > 0}>
        <div class="flex flex-wrap gap-2">
          <For each={props.pod.repos}>
            {(repo) => (
              <div class="flex items-center gap-1.5 text-xs bg-zinc-800/50 rounded px-2 py-1">
                <span class="text-zinc-400">{repo.name}</span>
                <span class="text-zinc-600">/</span>
                <span class="text-cyan-400 font-mono">{repo.branch}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function LoadingState() {
  return (
    <div class="text-sm text-zinc-500 animate-pulse">Loading pods...</div>
  );
}

function EmptyState() {
  return (
    <div class="text-sm text-zinc-500 border border-dashed border-zinc-800 rounded-lg p-8 text-center">
      No pods found. Create one with{" "}
      <code class="text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">
        isopod create &lt;name&gt;
      </code>
    </div>
  );
}
