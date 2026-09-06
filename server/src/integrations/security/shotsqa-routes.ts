/**
 * /api/shotsqa — the last QA pass over the venture screenshots, and the button.
 *
 * THE READ IS THE ROWS AND NOT THE REPORT. The markdown a pass writes lives on
 * the run, at `/api/runs/:id`, exactly like every other run's report; what this
 * route serves is the per-venture rows, which is what a table draws and what an
 * agent can answer a question out of without parsing prose. Both are the same
 * pass and neither is derived from the other — `storeQa` and `report` are given
 * the same object.
 *
 * THE BUTTON QUEUES A RUN RATHER THAN DOING THE WORK. Decoding eleven PNGs is
 * seconds of CPU, which is too long to hold a request and exactly what the run
 * queue is for. It is also what gives the pass a ledger entry, a page, a
 * cancel, and a report that survives the tab closing.
 */
import { Hono } from "hono";
import { insertRun, mintRunId, runRow, runRows, shapeRun } from "../runs/store.ts";
import { pump } from "../runs/executor.ts";
import { latestRows, passes, type Check, type PixelStats } from "./shotsqa.ts";

export const shotsqaRoutes = new Hono();

type Stored = { checks: Check[]; pixels: PixelStats | null; website: string | null };

function readStored(raw: string): Stored {
  try {
    const doc = JSON.parse(raw) as Partial<Stored>;
    return {
      checks: Array.isArray(doc.checks) ? doc.checks : [],
      pixels: doc.pixels ?? null,
      website: doc.website ?? null,
    };
  } catch {
    return { checks: [], pixels: null, website: null };
  }
}

shotsqaRoutes.get("/", (c) => {
  const runId = c.req.query("run") ?? null;
  const rows = latestRows(runId);
  const history = passes();
  const runs = runRows({ kind: "shotsqa", limit: 20 }).map(shapeRun);

  return c.json({
    runId: rows[0]?.run_id ?? null,
    ts: rows[0]?.ts ?? null,
    ventures: rows.map((r) => {
      const stored = readStored(r.checks);
      return {
        ventureId: r.venture_id,
        venture: r.venture,
        website: stored.website,
        shotTs: r.shot_ts,
        shotPath: r.shot_path,
        ageDays: r.age_days,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
        failed: r.failed,
        unchecked: r.unchecked,
        pixels: stored.pixels,
        checks: stored.checks,
      };
    }),
    passes: history,
    runs,
    note:
      "Three verdicts, never two: `pass`, `fail` and `unchecked`. `unchecked` means the check could not be run — " +
      "no audit on file, no title ever read, the PNG already pruned off disk — and it is NEVER a pass. " +
      "No model looks at these pictures: nothing on this box says whether a configured provider can accept an " +
      "image, so every verdict here is arithmetic over the PNG and over two tables.",
  });
});

shotsqaRoutes.post("/run", (c) => {
  const id = mintRunId();
  insertRun({ id, kind: "shotsqa", ventureId: null, title: "Screenshot QA", input: {} });
  /* Started now rather than at the next tick, so a box with a free slot answers
     "running" instead of "queued a moment ago". A no-op when the slot is busy. */
  pump();
  const row = runRow(id);
  return c.json(row ? shapeRun(row) : { id, kind: "shotsqa", status: "queued" }, 201);
});
