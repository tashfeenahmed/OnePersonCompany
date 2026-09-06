import { useCallback, useRef, useState } from "react";
function readDraft(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
/** Persist each edit, including edits arriving after a file read or route change. */
export function useDraft(key: string, fallback = "") {
  const [stored, setStored] = useState(() => ({ key, value: readDraft(key, fallback) }));
  const latest = useRef(new Map<string, string>());
  const [error, setError] = useState<string | null>(null);
  const value = stored.key === key ? stored.value : readDraft(key, fallback);
  const setValue = useCallback((next: string | ((previous: string) => string)) => {
    const previous = latest.current.get(key) ?? readDraft(key, fallback);
    const value = typeof next === "function" ? next(previous) : next;
    latest.current.set(key, value); setStored({ key, value });
    try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); setError(null); }
    catch { setError("This draft could not be saved. Copy it before leaving this page."); }
  }, [key, fallback]);
  return [value, setValue, error] as const;
}
