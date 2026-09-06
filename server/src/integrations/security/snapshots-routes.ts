/**
 * /api/snapshots — the instants, listed and read.
 *
 * THREE ROUTES AND ONE OF THEM WRITES. The list is a table of dates because a
 * snapshot is a hundred kilobytes of transcript and nobody wants thirty of them
 * to choose one; `/:id` is the document; and `POST /:host/now` is the button,
 * which takes about a second of ssh and is therefore allowed to be a request
 * that waits rather than a job that queues.
 *
 * THE DOCUMENT IS RETURNED AS IT WAS STORED. No re-shaping on the read: what a
 * box said at 03:12 is the record, and a route that re-derived a summary from
 * it every time would be a second opinion about a moment that is over.
 */
import { Hono } from "hono";
import { boxes, findBox, lastSnapshotAt, snapshotList, snapshotRow, takeSnapshot } from "./snapshots.ts";

export const snapshotRoutes = new Hono();

/**
 * The list, and the boxes it could be taken of.
 *
 * `hosts` is on the same document rather than a route of its own because the
 * page needs both to draw anything at all — a list of snapshots with no list of
 * boxes has nothing to put a "capture now" button beside, and a box with no
 * snapshots is exactly the state a new install is in.
 */
snapshotRoutes.get("/", (c) => {
  const host = c.req.query("host");
  const limit = Number(c.req.query("limit") ?? 50);
  const { ready, problems } = boxes();

  const box = host ? findBox(host) : null;
  if (host && !box)
    return c.json(
      {
        error: `No connected fleet box is called “${host}”.`,
        hosts: ready.map((b) => ({ id: b.accountId, label: b.label })),
      },
      404,
    );

  return c.json({
    hosts: ready.map((b) => ({
      id: b.accountId,
      label: b.label,
      /* The ssh target, which is not a secret — it is what the owner typed on
         the plugin page and what every error message here quotes back. The KEY
         is never on this document and there is no route that returns one. */
      target: `${b.target.user}@${b.target.host}${b.target.port ? `:${b.target.port}` : ""}`,
      lastSnapshotAt: lastSnapshotAt(b.accountId),
    })),
    problems,
    filteredTo: box ? { id: box.accountId, label: box.label } : null,
    snapshots: snapshotList({ accountId: box?.accountId ?? null, limit }),
    note:
      "A snapshot is ONE INSTANT captured over ssh — processes, listening sockets, disks, the log tail — not a trend. " +
      "Two snapshots of one box are two moments and nothing between them was measured. " +
      "They are taken on demand, or automatically when an uptime host linked to the same venture as a box goes down " +
      "(at most one automatic capture per box per hour).",
  });
});

/**
 * Capture now.
 *
 * IT WAITS FOR THE ssh, which is a decision rather than an oversight: fleet's
 * own probe is capped at 45 seconds and this script is shorter than that, so
 * the request is a second or two on a healthy box and up to three quarters of a
 * minute on a sick one. A queue would buy nothing except a second page to look
 * at to find out whether the thing you just pressed happened.
 *
 * A REFUSED ssh IS A 200 WITH `ok: false`, not a 502. The row was written, the
 * capture is a real record of a box that would not answer, and the caller is
 * given the id of it.
 */
snapshotRoutes.post("/:host/now", async (c) => {
  const key = c.req.param("host");
  const box = findBox(key);
  if (!box) {
    const { ready } = boxes();
    return c.json(
      {
        error: `No connected fleet box is called “${key}”.`,
        hosts: ready.map((b) => ({ id: b.accountId, label: b.label })),
      },
      404,
    );
  }
  const reason = (await c.req.json().catch(() => null) as { reason?: unknown } | null)?.reason;
  const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 200) : "asked for";
  const { id, doc } = await takeSnapshot(box, why);
  return c.json({ id, ...doc });
});

snapshotRoutes.get("/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "A snapshot id is a whole number." }, 400);
  const row = snapshotRow(id);
  if (!row) return c.json({ error: `There is no snapshot #${id}.` }, 404);
  let doc: unknown;
  try {
    doc = JSON.parse(row.doc);
  } catch {
    return c.json({ error: `Snapshot #${id} is on disk but its document will not parse.`, size: row.size }, 500);
  }
  return c.json({ id: row.id, accountId: row.account_id, size: row.size, ...(doc as object) });
});
