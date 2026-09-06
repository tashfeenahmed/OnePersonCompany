import { useCallback, useEffect, useRef, useState } from "react";

/** Latest request wins, including manual reloads and dependency changes. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const run = useCallback(fn, deps);
  const reload = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    Promise.resolve().then(run)
      .then(value => { if (generation.current === current) { setData(value); setError(null); } })
      .catch((error: unknown) => { if (generation.current === current) setError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (generation.current === current) setLoading(false); });
  }, [run]);
  useEffect(() => { setData(null); reload(); return () => { generation.current++; }; }, [reload]);
  return { data, error, loading, reload, setData };
}
