import { createResource, createSignal, createEffect, For, Show } from "solid-js";
import { fetchWorkspaceTree, fetchSharing, updateSharing } from "../../api";
import { createPolledKeyedResource } from "../../lib/poll";
import type { WorkspaceNode, SharingMode } from "../../types";

// Client-side mirror of the engine resolver (api/src/sharing.ts) so the tree
// reflects the *unsaved* working copy live: effective mode = the override whose
// key is the longest prefix of (or equal to) the path, else the working default.
function makeResolver(def: () => SharingMode, overrides: () => Record<string, SharingMode>) {
  const effectiveMode = (path: string): SharingMode => {
    let bestLen = -1;
    let best = def();
    const ov = overrides();
    for (const k of Object.keys(ov)) {
      if (path === k || path.startsWith(k + "/")) {
        if (k.length > bestLen) {
          bestLen = k.length;
          best = ov[k];
        }
      }
    }
    return best;
  };
  const hasUnder = (path: string, target: SharingMode): boolean =>
    Object.keys(overrides()).some((k) => k.startsWith(path + "/") && overrides()[k] === target);
  const dirState = (path: string): "shared" | "local" | "mixed" => {
    const m = effectiveMode(path);
    if (m === "shared" && !hasUnder(path, "local")) return "shared";
    if (m === "local" && !hasUnder(path, "shared")) return "local";
    return "mixed";
  };
  return { effectiveMode, dirState };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Canonical (key-sorted) stringify so the dirty check is order-insensitive:
// the server writes overrides sorted, but re-toggling a key (delete + re-add)
// moves it to the end of the object, which would otherwise read as "dirty".
function canon(def: SharingMode, overrides: Record<string, SharingMode>): string {
  const sorted = Object.fromEntries(Object.keys(overrides).sort().map((k) => [k, overrides[k]]));
  return JSON.stringify({ default: def, overrides: sorted });
}

export function WorkspaceSharing(props: { stack: string }) {
  // Tree structure + sizes come from the server (re-fetched per stack); the
  // displayed *mode* is recomputed client-side from the working copy below.
  const [tree] = createResource(() => props.stack, fetchWorkspaceTree, {
    initialValue: { default: "local" as SharingMode, nodes: [] },
  });

  // Tag the manifest with the stack it was fetched for, so the seeding effect
  // can ignore a stale value left over from the previous stack mid-refetch.
  const [sharing, refetchSharing] = createPolledKeyedResource(
    () => props.stack,
    async (stack: string) => ({ stack, ...(await fetchSharing(stack)) }),
  );

  // Editable working copy (independent of the server until saved).
  const [workingDefault, setWorkingDefault] = createSignal<SharingMode>("local");
  const [workingOverrides, setWorkingOverrides] = createSignal<Record<string, SharingMode>>({});
  const [loadedSnapshot, setLoadedSnapshot] = createSignal(canon("local", {}));
  const [saving, setSaving] = createSignal(false);
  const [seededStack, setSeededStack] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  const syncFromServer = (s: { default: SharingMode; overrides: Record<string, SharingMode> }) => {
    setWorkingDefault(s.default);
    setWorkingOverrides({ ...s.overrides });
    setLoadedSnapshot(canon(s.default, s.overrides));
  };

  // Seed the working copy whenever the stack changes (or on first load), but
  // ONLY from data that belongs to the current stack — and not again on the
  // 5s poll for the same stack, so unsaved edits survive the banner refresh.
  createEffect(() => {
    const s = sharing();
    if (s && s.stack === props.stack && seededStack() !== props.stack) {
      syncFromServer(s);
      setSeededStack(props.stack);
      setExpanded(new Set<string>());
    }
  });

  const { effectiveMode, dirState } = makeResolver(workingDefault, workingOverrides);

  const current = () => canon(workingDefault(), workingOverrides());
  const dirty = () => current() !== loadedSnapshot();

  // True only once the working copy has been seeded from THIS stack's manifest.
  // Until then (initial load, or the brief window after switching stacks while
  // the new manifest is still fetching), the working copy may hold the previous
  // stack's edits — so Save/Reset/banner must be inert to avoid writing stack
  // A's overrides into stack B.
  const ready = () => seededStack() === props.stack;

  // Toggle an explicit override on a path. Clicking the active mode clears it
  // (the path falls back to inheriting from its parent / the default).
  const setMode = (path: string, mode: SharingMode) => {
    setWorkingOverrides((prev) => {
      const next = { ...prev };
      if (next[path] === mode) delete next[path];
      else next[path] = mode;
      return next;
    });
  };

  const toggleExpanded = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  async function save() {
    if (!ready()) return; // never post the previous stack's working copy to this stack
    setSaving(true);
    try {
      await updateSharing(props.stack, { default: workingDefault(), overrides: workingOverrides() });
      setLoadedSnapshot(current());
      refetchSharing();
    } catch (e) {
      console.error(e);
      alert("Failed to save sharing manifest. See console.");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (!ready()) return;
    const s = sharing();
    if (s) syncFromServer(s);
  }

  const runningPods = () => sharing()?.runningPods ?? [];

  return (
    <div class="flex flex-col flex-1 min-h-0">
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-xl font-semibold">Workspace Sharing</h2>
        <div class="flex items-center gap-2">
          <button
            class="px-3 py-1.5 text-sm rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-40"
            onClick={reset}
            disabled={!ready() || !dirty() || saving()}
          >
            Reset
          </button>
          <button
            class="px-3 py-1.5 text-sm rounded bg-emerald-700 text-emerald-50 hover:bg-emerald-600 transition-colors disabled:opacity-40"
            onClick={save}
            disabled={!ready() || !dirty() || saving()}
          >
            {saving() ? "Saving..." : dirty() ? "Save changes" : "Saved"}
          </button>
        </div>
      </div>

      <p class="text-sm text-zinc-500 mb-4">
        Mark each workspace entry <span class="text-cyan-400">shared</span> (a live bind mount of the
        canonical template — edits flow back and across pods) or <span class="text-amber-400">local</span>{" "}
        (the default: a per-pod copy whose edits stay in that pod). Children inherit their parent's
        setting; set an explicit mode to override. Applies to each pod on its next{" "}
        <span class="font-mono">up</span>.
      </p>

      {/* Restart banner — running pods in THIS stack need an `up` to apply changes */}
      <Show when={ready() && dirty() && runningPods().length > 0}>
        <div class="mb-4 rounded-lg border border-amber-900/50 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-300">
          {runningPods().length} running pod{runningPods().length === 1 ? "" : "s"} will need a restart
          (<span class="font-mono">isopod up</span>) to apply changes:{" "}
          <span class="font-mono text-amber-200">{runningPods().join(", ")}</span>
        </div>
      </Show>

      {/* Default selector */}
      <div class="flex items-center gap-3 mb-3 border border-zinc-800 rounded-lg bg-zinc-900/50 px-4 py-2.5">
        <span class="text-sm text-zinc-400">Default for unmarked entries</span>
        <ModeToggle value={workingDefault()} explicit={workingDefault()} onPick={(m) => setWorkingDefault(m)} />
      </div>

      <div class="flex-1 min-h-0 overflow-auto border border-zinc-800 rounded-lg bg-zinc-900/30">
        <Show
          when={tree()!.nodes.length > 0}
          fallback={
            <div class="p-6 text-sm text-zinc-500">
              {props.stack}'s workspace template is empty — nothing to configure.
            </div>
          }
        >
          <div class="py-1">
            <For each={tree()!.nodes}>
              {(node) => (
                <TreeRow
                  node={node}
                  depth={0}
                  expanded={expanded()}
                  onToggleExpand={toggleExpanded}
                  resolveFile={effectiveMode}
                  resolveDir={dirState}
                  explicitOf={(p) => workingOverrides()[p]}
                  onPick={setMode}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

function TreeRow(props: {
  node: WorkspaceNode;
  depth: number;
  expanded: Set<string>;
  onToggleExpand: (path: string) => void;
  resolveFile: (path: string) => SharingMode;
  resolveDir: (path: string) => "shared" | "local" | "mixed";
  explicitOf: (path: string) => SharingMode | undefined;
  onPick: (path: string, mode: SharingMode) => void;
}) {
  const isDir = () => props.node.type === "dir";
  const isOpen = () => props.expanded.has(props.node.path);
  const state = () => (isDir() ? props.resolveDir(props.node.path) : props.resolveFile(props.node.path));

  return (
    <>
      <div
        class="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800/30 transition-colors group"
        style={{ "padding-left": `${0.75 + props.depth * 1.25}rem` }}
      >
        <button
          class="w-4 flex-shrink-0 text-zinc-500 hover:text-zinc-300"
          onClick={() => isDir() && props.onToggleExpand(props.node.path)}
        >
          <Show when={isDir()} fallback={<span />}>
            {isOpen() ? "▾" : "▸"}
          </Show>
        </button>

        <span class={`text-sm flex-shrink-0 ${isDir() ? "text-zinc-200 font-medium" : "text-zinc-300"}`}>
          {props.node.name}
          {isDir() ? "/" : ""}
        </span>

        <Show when={!isDir() && props.node.size > 0}>
          <span class="text-xs text-zinc-600 font-mono">{formatSize(props.node.size)}</span>
        </Show>

        <StateBadge state={state()} />

        <div class="ml-auto flex items-center gap-2">
          <Show when={props.explicitOf(props.node.path) === undefined}>
            <span class="text-xs text-zinc-600 italic">inherited</span>
          </Show>
          <ModeToggle
            value={state()}
            explicit={props.explicitOf(props.node.path)}
            label={isDir() ? "all" : undefined}
            onPick={(m) => props.onPick(props.node.path, m)}
          />
        </div>
      </div>

      <Show when={isDir() && isOpen() && props.node.children}>
        <For each={props.node.children}>
          {(child) => (
            <TreeRow
              node={child}
              depth={props.depth + 1}
              expanded={props.expanded}
              onToggleExpand={props.onToggleExpand}
              resolveFile={props.resolveFile}
              resolveDir={props.resolveDir}
              explicitOf={props.explicitOf}
              onPick={props.onPick}
            />
          )}
        </For>
      </Show>
    </>
  );
}

function StateBadge(props: { state: "shared" | "local" | "mixed" }) {
  const cls = () =>
    props.state === "shared"
      ? "bg-cyan-900/30 text-cyan-400"
      : props.state === "local"
        ? "bg-amber-900/30 text-amber-400"
        : "bg-zinc-800 text-zinc-400";
  return <span class={`text-xs px-1.5 py-0.5 rounded ${cls()}`}>{props.state}</span>;
}

// Segmented [shared | local] control. The button matching the explicit override
// is highlighted; clicking it again clears the override (handled by the parent).
function ModeToggle(props: {
  value: "shared" | "local" | "mixed";
  explicit: SharingMode | undefined;
  label?: string;
  onPick: (mode: SharingMode) => void;
}) {
  const btn = (mode: SharingMode, text: string) => (
    <button
      class={`px-2 py-0.5 text-xs transition-colors ${
        props.explicit === mode
          ? mode === "shared"
            ? "bg-cyan-700 text-cyan-50"
            : "bg-amber-700 text-amber-50"
          : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50"
      }`}
      onClick={() => props.onPick(mode)}
    >
      {text}
    </button>
  );
  return (
    <div class="flex rounded overflow-hidden border border-zinc-700">
      {btn("shared", props.label ? "all shared" : "shared")}
      <span class="w-px bg-zinc-700" />
      {btn("local", props.label ? "all local" : "local")}
    </div>
  );
}
