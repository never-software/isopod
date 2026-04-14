import { createResource, createSignal, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { fetchSettings, updateSettings, fetchIndexer, indexerStart, indexerStop } from "../../api";
import { createPolledResource } from "../../lib/poll";
import type { ServicePort } from "../../types";

export function SettingsOverview(props: { stack?: string }) {
  const [settings, { refetch }] = createResource(fetchSettings, {
    initialValue: { autoStart: false, services: [] },
  });
  const [services, setServices] = createStore<ServicePort[]>([]);
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [autoStart, setAutoStart] = createSignal(false);
  const [indexer, refetchIndexer] = createPolledResource(fetchIndexer, { running: false, pid: null });
  const [indexerLoading, setIndexerLoading] = createSignal(false);

  // Sync from server when settings load
  const syncFromServer = () => {
    const s = settings();
    if (s) {
      setServices(reconcile(s.services || []));
      setAutoStart(s.autoStart ?? false);
      setDirty(false);
    }
  };

  // Run on initial load and refetch
  createResource(() => settings(), syncFromServer);

  function addService() {
    setServices(services.length, { label: "", port: 0, protocol: "http" });
    setDirty(true);
  }

  function removeService(index: number) {
    setServices((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }

  function updateField<K extends keyof ServicePort>(index: number, field: K, value: ServicePort[K]) {
    setServices(index, field, value);
    setDirty(true);
  }

  function toggleAutoStart() {
    setAutoStart((v) => !v);
    setDirty(true);
  }

  async function toggleIndexer() {
    setIndexerLoading(true);
    try {
      if (indexer()?.running) {
        await indexerStop();
      } else {
        await indexerStart();
      }
      setTimeout(() => {
        refetchIndexer();
        setIndexerLoading(false);
      }, 1000);
    } catch {
      setIndexerLoading(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const valid = services.filter((s) => s.label.trim() && s.port > 0);
      await updateSettings({ autoStart: autoStart(), services: valid });
      await refetch();
      syncFromServer();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-semibold">Settings</h2>
        <Show when={dirty()}>
          <button
            class="px-3 py-1.5 text-xs rounded-lg bg-emerald-900/50 text-emerald-400 hover:bg-emerald-900 transition-colors disabled:opacity-50"
            onClick={save}
            disabled={saving()}
          >
            {saving() ? "Saving..." : "Save Changes"}
          </button>
        </Show>
      </div>

      {/* Indexer section — only in landing settings */}
      <Show when={!props.stack}>
        <section class="mb-8">
          <h3 class="text-sm font-medium text-zinc-400 mb-3">Indexer</h3>
          <div class="border border-zinc-800 rounded-lg bg-zinc-900/50 p-4 space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-sm text-zinc-200">Indexer</div>
                <div class="text-xs text-zinc-500 mt-0.5">
                  {indexer()?.running
                    ? <span>Running <span class="font-mono text-zinc-600">PID {indexer()!.pid}</span></span>
                    : "Stopped"}
                </div>
              </div>
              <button
                class={`px-2.5 py-1 text-xs rounded transition-colors disabled:opacity-50 ${
                  indexer()?.running
                    ? "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                    : "bg-emerald-900/50 text-emerald-400 hover:bg-emerald-900"
                }`}
                onClick={toggleIndexer}
                disabled={indexerLoading()}
              >
                {indexerLoading() ? "..." : indexer()?.running ? "Stop" : "Start"}
              </button>
            </div>
            <div class="flex items-center justify-between pt-3 border-t border-zinc-800">
              <div>
                <div class="text-sm text-zinc-200">Auto-start</div>
                <div class="text-xs text-zinc-500 mt-0.5">Start the indexer when the dashboard opens</div>
              </div>
              <button
                class={`w-8 h-4 rounded-full relative transition-colors flex-shrink-0 ${
                  autoStart() ? "bg-emerald-600" : "bg-zinc-700"
                }`}
                onClick={toggleAutoStart}
              >
                <span class={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                  autoStart() ? "left-4" : "left-0.5"
                }`} />
              </button>
            </div>
          </div>
        </section>
      </Show>

      {/* Services section */}
      <section>
        <div class="flex items-center justify-between mb-3">
          <div>
            <h3 class="text-sm font-medium text-zinc-400">Services</h3>
            <p class="text-xs text-zinc-600 mt-0.5">
              Ports to show as clickable URLs on running pods
            </p>
          </div>
          <button
            class="px-2.5 py-1 text-xs rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-colors"
            onClick={addService}
          >
            Add Service
          </button>
        </div>

        <Show
          when={services.length > 0}
          fallback={
            <div class="text-sm text-zinc-500 border border-dashed border-zinc-800 rounded-lg p-6 text-center">
              No services configured. Add one to see URLs on pod cards.
            </div>
          }
        >
          <div class="border border-zinc-800 rounded-lg bg-zinc-900/50 divide-y divide-zinc-800/50">
            <For each={services}>
              {(service, index) => (
                <div class="flex items-center gap-3 px-4 py-3">
                  <input
                    type="text"
                    placeholder="Label"
                    value={service.label}
                    onInput={(e) => updateField(index(), "label", e.currentTarget.value)}
                    class="w-32 bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                  />
                  <input
                    type="number"
                    placeholder="Port"
                    value={service.port || ""}
                    onInput={(e) => updateField(index(), "port", parseInt(e.currentTarget.value) || 0)}
                    class="w-24 bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 font-mono"
                  />
                  <select
                    value={service.protocol}
                    onChange={(e) => updateField(index(), "protocol", e.currentTarget.value as "http" | "https")}
                    class="bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
                  >
                    <option value="http">http</option>
                    <option value="https">https</option>
                  </select>
                  <span class="flex-1 text-xs text-zinc-600 font-mono truncate">
                    {service.label && service.port
                      ? `${service.protocol}://ip-{stack}-{pod}.orb.local:${service.port}`
                      : ""}
                  </span>
                  <button
                    class="text-xs text-zinc-600 hover:text-red-400 transition-colors"
                    onClick={() => removeService(index())}
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </div>
  );
}
