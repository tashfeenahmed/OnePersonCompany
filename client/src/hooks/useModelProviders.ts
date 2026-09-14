import { useSyncExternalStore } from "react";
import { api, type ModelProviders, type ProviderId } from "@/lib/api";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  freellmapi: "FreeLLMAPI", openrouter: "OpenRouter", local: "Local", openai: "OpenAI",
};
type Snapshot = { data: ModelProviders | null; error: string | null; saving: boolean };
let snapshot: Snapshot = { data: null, error: null, saving: false };
let generation = 0;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const read = () => snapshot;

/** One server-backed choice for the account menu, Chat and Settings. A slow
 * read started before a selection cannot overwrite the saved selection. */
async function reload() {
  if (snapshot.saving) return;
  if (pending) return pending;
  const version = generation;
  const request = api.modelProviders().then(data => {
    if (version === generation) { snapshot = { ...snapshot, data, error: null }; emit(); }
  }).catch(error => {
    if (version === generation) { snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error) }; emit(); }
  }).finally(() => { if (pending === request) pending = null; });
  pending = request;
  return request;
}

async function choose(provider: ProviderId | null) {
  if (snapshot.saving) return;
  generation += 1;
  pending = null;
  snapshot = { ...snapshot, saving: true, error: null }; emit();
  try {
    const data = await api.setModelProvider(provider);
    snapshot = { data, saving: false, error: null }; emit();
    window.dispatchEvent(new Event("opc:model-changed"));
    try { localStorage.setItem("opc-model-changed", String(Date.now())); } catch { /* polling still works */ }
  } catch (error) {
    snapshot = { ...snapshot, saving: false, error: error instanceof Error ? error.message : String(error) }; emit();
    throw error;
  }
}

let stop: (() => void) | null = null;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const refresh = () => { if (!document.hidden) void reload(); };
    const storage = (event: StorageEvent) => { if (event.key === "opc-model-changed") refresh(); };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", storage);
    window.addEventListener("opc:data-changed", refresh);
    document.addEventListener("visibilitychange", refresh);
    stop = () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", storage);
      window.removeEventListener("opc:data-changed", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
    void reload();
  }
  return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); stop = null; } };
}

export function useModelProviders() {
  return { ...useSyncExternalStore(subscribe, read, read), reload, choose };
}
