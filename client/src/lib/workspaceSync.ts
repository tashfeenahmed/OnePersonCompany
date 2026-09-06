import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, call } from "./api";
import type { StoreState } from "./store";
import { isWorkspacePreferences } from "../../../shared/workspace";
type Preferences = Pick<StoreState, "workspace" | "sessions" | "dashboards" | "appOrder" | "seedVersion" | "favoritePaths" | "pinnedItems">;
type Document = { revision: number; data: Preferences | null };
const META = "opc-workspace-sync";
export function preferences(s: StoreState): Preferences {
  return { workspace: s.workspace, sessions: s.sessions, dashboards: s.dashboards, appOrder: s.appOrder, seedVersion: s.seedVersion, favoritePaths: s.favoritePaths, pinnedItems: s.pinnedItems };
}
export function saveRecovery(state: StoreState) { localStorage.setItem("opc-workspace-recovery", JSON.stringify(state)); }
function metadata(): { revision: number; saved: string | null; hasLocal: boolean } {
  try {
    const m = JSON.parse(localStorage.getItem(META) || "null");
    return { revision: Number.isInteger(m?.revision) ? m.revision : 0, saved: typeof m?.saved === "string" ? m.saved : null, hasLocal: !!localStorage.getItem("opc-state-v5") };
  } catch { return { revision: 0, saved: null, hasLocal: false }; }
}
export function useWorkspaceSync(state: StoreState, setState: React.Dispatch<React.SetStateAction<StoreState>>) {
  const current = useRef(state);
  useLayoutEffect(() => { current.current = state; }, [state]);
  const [initial] = useState(metadata);
  const revision = useRef(initial.revision), saved = useRef(initial.saved), busy = useRef(false), conflict = useRef(false);
  const [status, setStatus] = useState("Connecting to workspace…"), [ready, setReady] = useState(false), [hasConflict, setConflict] = useState(false);
  const actions = useRef<{ sync: () => Promise<void>; resolve: (local: boolean) => Promise<void> } | null>(null);
  useEffect(() => {
    let alive = true, hydrated = false;
    const initialJson = JSON.stringify(preferences(current.current));
    const get = async () => {
      const doc = await call<Document>("/workspace");
      if (doc.data && !isWorkspacePreferences(doc.data)) throw new Error("The saved workspace is invalid. Export your browser copy before restoring a backup.");
      return doc;
    };
    const remember = () => { localStorage.setItem(META, JSON.stringify({ revision: revision.current, saved: saved.current })); };
    const accept = (doc: Document) => {
      revision.current = doc.revision;
      saved.current = doc.data ? JSON.stringify(doc.data) : null;
      if (doc.data) {
        // An older workspace has favorites but no pinnedItems; accepting it must
        // also clear a newer browser's pin list instead of silently merging it.
        current.current = { ...current.current, pinnedItems: undefined, favoritePaths: undefined, ...doc.data };
        setState(s => ({ ...s, pinnedItems: undefined, favoritePaths: undefined, ...doc.data }));
      }
      remember();
    };
    const sync = async () => {
      if (busy.current || conflict.current) return;
      busy.current = true;
      try {
        if (!hydrated) {
          const doc = await get(); if (!alive) return;
          const local = JSON.stringify(preferences(current.current));
          const dirty = (initial.saved !== null && local !== initial.saved) || local !== initialJson;
          const legacyConflict = initial.hasLocal && initial.saved === null && doc.data && local !== JSON.stringify(doc.data);
          hydrated = true; setReady(true);
          if (legacyConflict) throw new ApiError(409, "This browser and the server have different workspace preferences. Choose which to keep.");
          if (!dirty) accept(doc);
          else if (doc.revision !== revision.current) throw new ApiError(409, "Unsynced browser edits conflict with a newer server version. Choose which to keep.");
        }
        const value = preferences(current.current), json = JSON.stringify(value);
        if (json !== saved.current) {
          const out = await call<{ revision: number }>("/workspace", { method: "PUT", body: JSON.stringify({ revision: revision.current, data: value }) });
          if (!alive) return;
          revision.current = out.revision; saved.current = json; remember();
        } else {
          const doc = await get(); if (!alive) return;
          if (doc.revision !== revision.current && JSON.stringify(preferences(current.current)) === json) accept(doc);
        }
        setStatus("");
      } catch (error) {
        if (!alive) return;
        if (error instanceof ApiError && error.status === 409) { conflict.current = true; setConflict(true); }
        setStatus(error instanceof Error ? error.message : String(error)); setReady(true);
      } finally { busy.current = false; }
    };
    const resolve = async (local: boolean) => {
      if (busy.current) return;
      busy.current = true;
      try {
        saveRecovery(current.current);
        const doc = await get(); if (!alive) return;
        revision.current = doc.revision;
        if (!local) accept(doc); else saved.current = null;
        conflict.current = false; setConflict(false); setStatus(""); hydrated = true;
      } catch (error) { if (alive) setStatus(String(error)); }
      finally { busy.current = false; }
      await sync();
    };
    actions.current = { sync, resolve };
    void sync();
    const timer = window.setInterval(() => { if (!document.hidden) void sync(); }, 2500);
    const focus = () => { void sync(); };
    window.addEventListener("focus", focus);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [initial, setState]);
  return { status, ready, hasConflict, retry: () => actions.current?.sync(), resolve: (local: boolean) => actions.current?.resolve(local) };
}
