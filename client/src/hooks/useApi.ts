import { useCallback, useEffect, useState } from "react";

/**
 * One async call, with the three states a UI actually has to draw: loading,
 * failed, and an answer. `reload` re-runs it after a mutation.
 *
 * A rejected call is not thrown — the API being down is an ordinary condition
 * for a local service, and every caller here has something honest to render
 * instead ("the API is not running"), which a thrown error would replace with
 * a blank screen.
 */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The caller passes a fresh closure each render; deps say when it matters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);

  const reload = useCallback(() => {
    let alive = true;
    setLoading(true);
    run()
      .then((d) => alive && (setData(d), setError(null)))
      .catch(
        (e: unknown) =>
          alive && setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [run]);

  useEffect(() => reload(), [reload]);

  return { data, error, loading, reload, setData };
}
