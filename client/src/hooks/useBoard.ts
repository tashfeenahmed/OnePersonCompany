import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type BoardDoc } from "@/lib/api";
import { WORK_CHANGED } from "./useRunQueue";

/** Background arrivals never clear the board or replace an in-flight move. */
export function useBoard(paused: boolean) {
  const [data, setData] = useState<BoardDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const hold = useRef(paused);
  useLayoutEffect(() => { hold.current = paused; }, [paused]);
  const generation = useRef(0);
  const writing = useRef(0);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    if (hold.current || writing.current) return;
    const ticket = ++generation.current;
    try {
      const next = await api.board();
      if (alive.current && ticket === generation.current && !hold.current && !writing.current) {
        setData(next); setError(null);
      }
    } catch (e) {
      if (alive.current && ticket === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally { if (alive.current && ticket === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void Promise.resolve().then(reload);
    const changed = () => { if (document.visibilityState === "visible") void reload(); };
    const timer = setInterval(changed, 15_000);
    window.addEventListener(WORK_CHANGED, changed);
    document.addEventListener("visibilitychange", changed);
    const cancelReads = () => { alive.current = false; generation.current++; };
    return () => {
      cancelReads();
      clearInterval(timer);
      window.removeEventListener(WORK_CHANGED, changed);
      document.removeEventListener("visibilitychange", changed);
    };
  }, [reload]);
  async function mutate(call: () => Promise<BoardDoc>, optimistic?: BoardDoc) {
    const ticket = ++generation.current, previous = data;
    writing.current++;
    if (optimistic) setData(optimistic);
    try {
      const next = await call();
      if (alive.current && ticket === generation.current) { setData(next); setError(null); }
    } catch (e) {
      if (alive.current && ticket === generation.current && optimistic) setData(previous);
      throw e;
    } finally { writing.current--; }
  }
  return { data, error, loading, reload, mutate };
}
