import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, call } from "./api";
import type { StoreState } from "./store";
import { isWorkspacePreferences } from "../../../shared/workspace";
import { syncFailureNotice, workspaceFingerprint, workspaceHydrationChoice } from "./workspaceSyncPolicy";
type Preferences = Pick<StoreState, "workspace" | "sessions" | "dashboards" | "appOrder" | "navOrder" | "seedVersion" | "favoritePaths" | "pinnedItems" | "palette">;
type Document = { revision: number; data: Preferences | null };
const META = "opc-workspace-sync";
const unchanged = (state: StoreState) => state;
export function preferences(s: StoreState): Preferences {
  return { workspace: s.workspace, sessions: s.sessions, dashboards: s.dashboards, appOrder: s.appOrder, navOrder: s.navOrder, seedVersion: s.seedVersion, favoritePaths: s.favoritePaths, pinnedItems: s.pinnedItems, palette: s.palette };
}
export function saveRecovery(state: StoreState) { localStorage.setItem("opc-workspace-recovery", JSON.stringify(state)); }
function metadata(): { revision: number; saved: string | null; hasLocal: boolean } {
  try {
    const m = JSON.parse(localStorage.getItem(META) || "null");
    return { revision: Number.isInteger(m?.revision) ? m.revision : 0, saved: typeof m?.saved === "string" ? m.saved : null, hasLocal: !!localStorage.getItem("opc-state-v5") };
  } catch { return { revision: 0, saved: null, hasLocal: false }; }
}
/* Repair older data formats on both local load and server hydration. Saved
   dashboard membership, widgets and layout are never merged with templates. */
export function useWorkspaceSync(
  state: StoreState,
  setState: React.Dispatch<React.SetStateAction<StoreState>>,
  migrate: (s: StoreState) => StoreState = unchanged,
) {
  const current = useRef(state);
  useLayoutEffect(() => { current.current = state; }, [state]);
  const [initial] = useState(metadata);
  const revision = useRef(initial.revision), saved = useRef(initial.saved);
  const [status, setStatus] = useState(""), [ready, setReady] = useState(false), [hasConflict, setConflict] = useState(false);
  const actions = useRef<{ sync: () => Promise<void>; resolve: (local: boolean) => Promise<void> } | null>(null);
  useEffect(() => {
    let alive = true, hydrated = false, busy = false, conflict = false;
    let firstFailureAt: number | null = null;
    const initialJson = workspaceFingerprint(preferences(current.current));
    // Compare both copies in the current format. A format upgrade must not
    // look like an unsaved edit on the next load.
    const fingerprint = (data: Preferences | null) => data ? workspaceFingerprint(preferences(migrate({
      ...current.current, pinnedItems: undefined, favoritePaths: undefined, palette: undefined, navOrder: undefined, ...data,
    }))) : null;
    const savedFingerprint = () => {
      try { return saved.current ? fingerprint(JSON.parse(saved.current) as Preferences) : null; }
      catch { return null; }
    };
    const recovered = () => { firstFailureAt = null; setStatus(""); };
    const failed = (error: unknown) => {
      if (!alive) return;
      if (error instanceof ApiError && error.status === 409) { conflict = true; setConflict(true); }
      const notice = syncFailureNotice({
        message: error instanceof Error ? error.message : String(error),
        status: error instanceof ApiError ? error.status : undefined,
      }, firstFailureAt, Date.now());
      firstFailureAt = notice.firstFailureAt;
      // The conflict notice explains the choice itself. Keep this field for
      // transport/validation errors, including a failed resolution attempt.
      setStatus(error instanceof ApiError && error.status === 409 ? "" : notice.message); setReady(true);
    };
    const get = async () => {
      const doc = await call<Document>("/workspace", { signal: AbortSignal.timeout(10_000) });
      if (!doc || !Number.isInteger(doc.revision) || doc.revision < 0 || (doc.data !== null && !isWorkspacePreferences(doc.data)))
        throw new ApiError(422, "The saved workspace is invalid. Export your browser copy before restoring a backup.");
      return doc;
    };
    const remember = () => { localStorage.setItem(META, JSON.stringify({ revision: revision.current, saved: saved.current })); };
    const accept = (doc: Document) => {
      revision.current = doc.revision;
      saved.current = doc.data ? JSON.stringify(doc.data) : null;
      if (doc.data) {
        // An older workspace has favorites but no pinnedItems; accepting it must
        // also clear a newer browser's pin list instead of silently merging it.
        current.current = migrate({ ...current.current, pinnedItems: undefined, favoritePaths: undefined, palette: undefined, navOrder: undefined, ...doc.data });
        setState(s => migrate({ ...s, pinnedItems: undefined, favoritePaths: undefined, palette: undefined, navOrder: undefined, ...doc.data }));
      }
      remember();
    };
    const sync = async () => {
      if (!alive || busy || conflict) return;
      busy = true;
      try {
        if (!hydrated) {
          const doc = await get(); if (!alive) return;
          const choice = workspaceHydrationChoice({
            local: workspaceFingerprint(preferences(current.current)), server: fingerprint(doc.data),
            saved: savedFingerprint(), initial: initialJson, hasLocal: initial.hasLocal,
            revision: revision.current, serverRevision: doc.revision,
          });
          if (choice === "conflict") throw new ApiError(409, "This browser and the server have different workspace preferences. Choose which to keep.");
          if (choice === "accept") accept(doc);
          else revision.current = doc.revision;
          hydrated = true; setReady(true);
        }
        const value = preferences(current.current), json = workspaceFingerprint(value);
        if (json !== savedFingerprint()) {
          const out = await call<{ revision: number }>("/workspace", { method: "PUT", body: JSON.stringify({ revision: revision.current, data: value }), signal: AbortSignal.timeout(10_000) });
          if (!alive) return;
          revision.current = out.revision; saved.current = json; remember();
        } else {
          const doc = await get(); if (!alive) return;
          if (doc.revision !== revision.current && workspaceFingerprint(preferences(current.current)) === json) accept(doc);
        }
        recovered();
      } catch (error) {
        if (!alive) return;
        // A timed-out save may have succeeded, or another tab saved the same
        // preferences. Verify before asking the owner to resolve a conflict.
        if (hydrated && error instanceof ApiError && error.status === 409) {
          try {
            const doc = await get(); if (!alive) return;
            const remote = fingerprint(doc.data);
            if (remote === workspaceFingerprint(preferences(current.current))) { accept(doc); recovered(); return; }
            if (remote === savedFingerprint()) { revision.current = doc.revision; recovered(); return; }
          } catch (checkError) { failed(checkError); return; }
        }
        failed(error);
      } finally { busy = false; }
    };
    const resolve = async (local: boolean) => {
      if (!alive || busy) return;
      busy = true;
      try {
        saveRecovery(current.current);
        const doc = await get(); if (!alive) return;
        revision.current = doc.revision;
        if (!local) accept(doc); else saved.current = null;
        conflict = false; setConflict(false); recovered(); hydrated = true;
      } catch (error) { if (alive) setStatus(String(error)); }
      finally { busy = false; }
      await sync();
    };
    actions.current = { sync, resolve };
    void sync();
    const timer = window.setInterval(() => { if (!document.hidden) void sync(); }, 2500);
    const focus = () => { void sync(); };
    window.addEventListener("focus", focus);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [initial, setState, migrate]);
  return { status, ready, hasConflict, retry: () => actions.current?.sync(), resolve: (local: boolean) => actions.current?.resolve(local) };
}
