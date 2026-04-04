import { createSignal, createResource, For, Show, onCleanup } from "solid-js";
import { fetchRepos, checkPodExists } from "../../api";
import type { Repo } from "../../types";

type Step = "config" | "branch" | "create";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export function CreatePodWizard(props: Props) {
  const [step, setStep] = createSignal<Step>("config");
  const [name, setName] = createSignal("");
  const [selectedRepos, setSelectedRepos] = createSignal<Set<string>>(new Set());
  const [fromBranch, setFromBranch] = createSignal("");
  const [nameError, setNameError] = createSignal("");
  const [logs, setLogs] = createSignal<string[]>([]);
  const [creating, setCreating] = createSignal(false);
  const [done, setDone] = createSignal(false);
  const [error, setError] = createSignal("");

  const [repos] = createResource(fetchRepos, { initialValue: [] });

  // Select all repos by default once loaded
  const reposLoaded = () => {
    if (repos()!.length > 0 && selectedRepos().size === 0) {
      setSelectedRepos(new Set(repos()!.map((r) => r.name)));
    }
  };
  // Trigger on access
  const _ = () => { reposLoaded(); return true; };

  function toggleRepo(name: string) {
    const s = new Set(selectedRepos());
    if (s.has(name)) s.delete(name);
    else s.add(name);
    setSelectedRepos(s);
  }

  function toggleAll() {
    if (selectedRepos().size === repos()!.length) {
      setSelectedRepos(new Set());
    } else {
      setSelectedRepos(new Set(repos()!.map((r) => r.name)));
    }
  }

  async function validateAndNext() {
    const n = name().trim();
    if (!n) {
      setNameError("Pod name is required");
      return;
    }
    if (selectedRepos().size === 0) {
      setNameError("Select at least one repo");
      return;
    }
    try {
      const { exists } = await checkPodExists(n);
      if (exists) {
        setNameError(`Pod '${n}' already exists`);
        return;
      }
    } catch { /* proceed */ }
    setNameError("");
    setStep("branch");
  }

  function startCreate() {
    setStep("create");
    setCreating(true);
    setLogs([]);
    setError("");

    const body = JSON.stringify({
      name: name().trim(),
      repos: Array.from(selectedRepos()),
      from: fromBranch().trim() || undefined,
    });

    fetch("/api/pods/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }).then(async (res) => {
      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "log") {
              setLogs((prev) => [...prev, event.line]);
            } else if (event.type === "done") {
              setCreating(false);
              setDone(true);
              props.onCreated();
            } else if (event.type === "error") {
              setCreating(false);
              setError(event.message);
            }
          } catch { /* skip malformed */ }
        }
      }
    }).catch((err) => {
      setCreating(false);
      setError(err.message);
    });
  }

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/60">
      <div class="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-2xl shadow-2xl">
        {/* Header */}
        <div class="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h3 class="text-base font-semibold">New Pod</h3>
          <Show when={!creating()}>
            <button
              class="text-zinc-500 hover:text-zinc-300 text-sm"
              onClick={props.onClose}
            >
              Cancel
            </button>
          </Show>
        </div>

        {/* Steps indicator */}
        <div class="flex gap-1 px-5 pt-4">
          <StepDot active={step() === "config"} done={step() !== "config"} label="1" />
          <div class="flex-1 border-t border-zinc-800 self-center" />
          <StepDot active={step() === "branch"} done={step() === "create"} label="2" />
          <div class="flex-1 border-t border-zinc-800 self-center" />
          <StepDot active={step() === "create"} done={done()} label="3" />
        </div>

        {/* Content */}
        <div class="p-5">
          <Show when={step() === "config"}>
            <ConfigStep
              name={name()}
              onNameChange={setName}
              nameError={nameError()}
              repos={repos()!}
              selectedRepos={selectedRepos()}
              onToggleRepo={toggleRepo}
              onToggleAll={toggleAll}
              onNext={validateAndNext}
              init={_}
            />
          </Show>

          <Show when={step() === "branch"}>
            <BranchStep
              repos={repos()!}
              selectedRepos={selectedRepos()}
              fromBranch={fromBranch()}
              onFromBranchChange={setFromBranch}
              onBack={() => setStep("config")}
              onNext={startCreate}
            />
          </Show>

          <Show when={step() === "create"}>
            <CreateStep
              logs={logs()}
              creating={creating()}
              done={done()}
              error={error()}
              onClose={props.onClose}
            />
          </Show>
        </div>
      </div>
    </div>
  );
}

// ── Step Components ─────────────────────────────────────────────────

function ConfigStep(props: {
  name: string;
  onNameChange: (v: string) => void;
  nameError: string;
  repos: Repo[];
  selectedRepos: Set<string>;
  onToggleRepo: (name: string) => void;
  onToggleAll: () => void;
  onNext: () => void;
  init: () => boolean;
}) {
  // Trigger init to select all repos on first render
  props.init();

  return (
    <div class="space-y-4">
      <div>
        <label class="text-xs text-zinc-500 block mb-1.5">Pod Name</label>
        <input
          type="text"
          placeholder="my-feature"
          class="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          value={props.name}
          onInput={(e) => props.onNameChange(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && props.onNext()}
          autofocus
        />
        <Show when={props.nameError}>
          <p class="text-xs text-red-400 mt-1">{props.nameError}</p>
        </Show>
      </div>

      <div>
        <div class="flex items-center justify-between mb-1.5">
          <label class="text-xs text-zinc-500">Repositories</label>
          <button
            class="text-xs text-zinc-500 hover:text-zinc-300"
            onClick={props.onToggleAll}
          >
            {props.selectedRepos.size === props.repos.length ? "Deselect All" : "Select All"}
          </button>
        </div>
        <div class="space-y-1">
          <For each={props.repos}>
            {(repo) => (
              <label class="flex items-center gap-2.5 px-3 py-2 rounded border border-zinc-800 bg-zinc-950 cursor-pointer hover:bg-zinc-800/30 transition-colors">
                <input
                  type="checkbox"
                  checked={props.selectedRepos.has(repo.name)}
                  onChange={() => props.onToggleRepo(repo.name)}
                  class="accent-emerald-500"
                />
                <span class="text-sm text-zinc-300">{repo.name}</span>
                <span class="text-xs text-zinc-600 ml-auto font-mono">{repo.defaultBranch}</span>
              </label>
            )}
          </For>
        </div>
      </div>

      <div class="flex justify-end pt-2">
        <button
          class="px-4 py-2 text-sm rounded-lg bg-emerald-900/50 text-emerald-400 hover:bg-emerald-900 transition-colors"
          onClick={props.onNext}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function BranchStep(props: {
  repos: Repo[];
  selectedRepos: Set<string>;
  fromBranch: string;
  onFromBranchChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const selected = () => props.repos.filter((r) => props.selectedRepos.has(r.name));

  return (
    <div class="space-y-4">
      <div>
        <label class="text-xs text-zinc-500 block mb-1.5">Start from branch <span class="text-zinc-600">(optional)</span></label>
        <input
          type="text"
          placeholder="Leave blank for default branch"
          class="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          value={props.fromBranch}
          onInput={(e) => props.onFromBranchChange(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && props.onNext()}
        />
      </div>

      <div>
        <label class="text-xs text-zinc-500 block mb-1.5">Branch per repo</label>
        <div class="space-y-1">
          <For each={selected()}>
            {(repo) => (
              <div class="flex items-center justify-between px-3 py-2 rounded border border-zinc-800 bg-zinc-950 text-xs">
                <span class="text-zinc-300">{repo.name}</span>
                <span class="font-mono text-cyan-400">{props.fromBranch || repo.defaultBranch}</span>
              </div>
            )}
          </For>
        </div>
      </div>

      <div class="flex justify-between pt-2">
        <button
          class="px-4 py-2 text-sm rounded-lg text-zinc-400 hover:text-zinc-200 transition-colors"
          onClick={props.onBack}
        >
          Back
        </button>
        <button
          class="px-4 py-2 text-sm rounded-lg bg-emerald-900/50 text-emerald-400 hover:bg-emerald-900 transition-colors"
          onClick={props.onNext}
        >
          Create Pod
        </button>
      </div>
    </div>
  );
}

function CreateStep(props: {
  logs: string[];
  creating: boolean;
  done: boolean;
  error: string;
  onClose: () => void;
}) {
  let logContainer: HTMLDivElement | undefined;

  // Auto-scroll to bottom
  const scrollToBottom = () => {
    if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
  };
  // Scroll when logs change
  const _ = () => { props.logs.length; setTimeout(scrollToBottom, 0); };

  return (
    <div class="space-y-3">
      {_() && null}

      <Show when={props.creating}>
        <div class="flex items-center gap-2 text-sm text-zinc-400">
          <span class="animate-pulse">Creating pod...</span>
        </div>
      </Show>

      <Show when={props.done}>
        <div class="flex items-center gap-2 text-sm text-emerald-400">
          <span>Pod created successfully!</span>
        </div>
      </Show>

      <Show when={props.error}>
        <div class="flex items-center gap-2 text-sm text-red-400">
          <span>{props.error}</span>
        </div>
      </Show>

      <div
        ref={logContainer}
        class="border border-zinc-800 rounded-lg bg-zinc-950 p-3 max-h-64 overflow-auto font-mono text-xs"
      >
        <Show
          when={props.logs.length > 0}
          fallback={<span class="text-zinc-600">Waiting for output...</span>}
        >
          <For each={props.logs}>
            {(line) => <div class="py-0.5 text-zinc-500">{line}</div>}
          </For>
        </Show>
      </div>

      <Show when={props.done || props.error}>
        <div class="flex justify-end pt-2">
          <button
            class="px-4 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            onClick={props.onClose}
          >
            Close
          </button>
        </div>
      </Show>
    </div>
  );
}

// ── Shared ──────────────────────────────────────────────────────────

function StepDot(props: { active: boolean; done: boolean; label: string }) {
  return (
    <div
      class={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-colors ${
        props.done
          ? "bg-emerald-600 text-white"
          : props.active
            ? "bg-cyan-600 text-white"
            : "bg-zinc-800 text-zinc-500"
      }`}
    >
      {props.done ? "✓" : props.label}
    </div>
  );
}
