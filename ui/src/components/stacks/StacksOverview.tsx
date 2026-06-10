import { createResource, createSignal, For, Show } from "solid-js";
import { fetchStacksDetail, buildStack } from "../../api";

export function StacksOverview(props: { onSelectStack: (name: string) => void }) {
  const [stacks, { refetch }] = createResource(fetchStacksDetail, { initialValue: [] });
  const [building, setBuilding] = createSignal<string | null>(null);
  const [buildLog, setBuildLog] = createSignal<string[]>([]);
  const [buildError, setBuildError] = createSignal<string | null>(null);

  let logEnd: HTMLDivElement | undefined;

  function scrollLog() {
    logEnd?.scrollIntoView({ behavior: "smooth" });
  }

  async function handleBuild(name: string) {
    setBuilding(name);
    setBuildLog([]);
    setBuildError(null);
    try {
      await buildStack(name, undefined, (msg) => {
        setBuildLog((prev) => [...prev, msg]);
        scrollLog();
      });
      refetch();
    } catch (e: any) {
      setBuildError(e.message);
    } finally {
      setBuilding(null);
    }
  }

  return (
    <div>
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-semibold">Stacks</h2>
        <button
          class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          onClick={() => refetch()}
        >
          Refresh
        </button>
      </div>

      <Show when={!stacks.loading} fallback={
        <div class="text-sm text-zinc-500 animate-pulse">Loading stacks...</div>
      }>
        <Show
          when={stacks()!.length > 0}
          fallback={
            <div class="text-sm text-zinc-500 border border-dashed border-zinc-800 rounded-lg p-8 text-center">
              No stacks found. The default stack uses{" "}
              <code class="text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">
                docker.local/
              </code>
              . Create a new stack by adding a directory to{" "}
              <code class="text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">
                stacks/&lt;name&gt;/
              </code>
            </div>
          }
        >
          <div class="space-y-3">
            <For each={stacks()!}>
              {(stack) => (
                <div
                  class="border border-zinc-800 rounded-lg bg-zinc-900/50 p-4 cursor-pointer hover:border-zinc-700 transition-colors"
                  onClick={() => props.onSelectStack(stack.name)}
                >
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-3">
                      <span class={`w-2.5 h-2.5 rounded-full ${stack.image.exists ? "bg-emerald-500" : "bg-zinc-600"}`} />
                      <h3 class="font-medium">{stack.name}</h3>
                      <Show when={stack.name === "default"}>
                        <span class="text-xs text-zinc-500">docker.local/</span>
                      </Show>
                      <Show when={stack.name !== "default"}>
                        <span class="text-xs text-zinc-500">stacks/{stack.name}/</span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-3">
                      <Show when={stack.image.exists}>
                        <div class="flex items-center gap-4 text-xs text-zinc-500">
                          <Show when={stack.image.sizeMB}>
                            <span>{stack.image.sizeMB} MB</span>
                          </Show>
                          <Show when={stack.image.created}>
                            <span>{stack.image.created}</span>
                          </Show>
                        </div>
                      </Show>
                      <Show when={!stack.image.exists && building() !== stack.name}>
                        <span class="text-xs text-zinc-500">not built</span>
                      </Show>
                      <button
                        class="px-2.5 py-1 text-xs rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-50"
                        onClick={(e: MouseEvent) => { e.stopPropagation(); handleBuild(stack.name); }}
                        disabled={building() !== null}
                      >
                        {building() === stack.name ? "Building..." : stack.image.exists ? "Rebuild" : "Build"}
                      </button>
                    </div>
                  </div>
                  <div class="mt-2 text-xs font-mono text-zinc-500">
                    {stack.image.name}
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      {/* Build log */}
      <Show when={buildLog().length > 0}>
        <div class="mt-6">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-xs font-medium text-zinc-500 uppercase tracking-wider">Build Output</h3>
            <button
              class="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
              onClick={() => setBuildLog([])}
            >
              Clear
            </button>
          </div>
          <div class="border border-zinc-800 rounded-lg bg-zinc-950 p-3 max-h-64 overflow-y-auto font-mono text-xs leading-5">
            <For each={buildLog()}>
              {(line) => <div class="text-zinc-400">{line}</div>}
            </For>
            <div ref={logEnd} />
          </div>
        </div>
      </Show>

      {/* Build error */}
      <Show when={buildError()}>
        <div class="mt-4 border border-red-900/50 rounded-lg bg-red-950/30 p-3">
          <p class="text-xs text-red-400">{buildError()}</p>
        </div>
      </Show>
    </div>
  );
}
