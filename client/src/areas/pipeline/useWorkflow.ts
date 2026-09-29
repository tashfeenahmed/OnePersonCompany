import { useCallback, useEffect, useMemo } from "react";
import { useApi } from "@/hooks/useApi";
import { pipelineApi, type Run } from "./api";
import type { StepInfo } from "./steps";

/**
 * EVERYTHING THE WORKFLOWS TABS READ, IN ONE PLACE: the schedule and its runs
 * (refreshed every five seconds while the tab is visible, so a run in
 * progress moves), the saved step definitions for names and artwork, and the
 * sub-agent queue the specialists wait in.
 */
export function useWorkflow() {
  const doc = useApi(() => pipelineApi.all(), []);
  const def = useApi(() => pipelineApi.workflow(), []);
  const queue = useApi(() => pipelineApi.queue(), []);
  const reloadDoc = doc.reload;
  const reloadQueue = queue.reload;
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") reloadDoc();
    }, 5000);
    const q = setInterval(() => {
      if (document.visibilityState === "visible") reloadQueue();
    }, 30000);
    return () => {
      clearInterval(t);
      clearInterval(q);
    };
  }, [reloadDoc, reloadQueue]);

  const blocks = def.data?.definition.blocks;
  const stages = doc.data?.stages;
  const lookup = useCallback(
    (id: string): StepInfo | undefined => {
      const b = blocks?.find((x) => x.id === id);
      const s = stages?.find((x) => x.id === id);
      if (!b && !s) return undefined;
      return { id, title: b?.title ?? s?.title ?? id, kind: b?.kind ?? null, role: b?.agent?.role ?? null, area: s?.area ?? null };
    },
    [blocks, stages],
  );
  const maxMinutesOf = useCallback(
    (id: string) => blocks?.find((x) => x.id === id)?.maxMinutes ?? stages?.find((x) => x.id === id)?.maxMinutes ?? null,
    [blocks, stages],
  );

  /** Real runs, newest first — the server's `history`, or the real ones among
   *  the recent runs when talking to an older server. */
  const history: Run[] = useMemo(
    () => doc.data?.history ?? (doc.data?.runs ?? []).filter((r) => !r.dry),
    [doc.data],
  );

  const reloadDef = def.reload;
  const reload = useCallback(() => {
    reloadDoc();
    reloadDef();
    reloadQueue();
  }, [reloadDoc, reloadDef, reloadQueue]);

  return { doc, def, queue, lookup, maxMinutesOf, history, reload };
}
