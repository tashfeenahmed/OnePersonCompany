/**
 * `/api/synthesis` — what was proposed, what was thrown away, and why.
 *
 * THE DROPPED PROPOSALS ARE A FIRST-CLASS VIEW, not a debugging aid. A pass
 * that files two cards out of nine and shows only the two is a pass the owner
 * cannot calibrate: he cannot tell whether it thought of the obvious thing and
 * rejected it for a good reason, or never thought of it at all. `?verdict=
 * dropped` is therefore an ordinary answer with the gate's own sentence on
 * every row.
 *
 * `POST /run` COSTS REAL MONEY. One model call per venture, against the whole
 * evidence packet. It is not marked destructive — filing a board card is
 * reversible, and the card says on its face that it is a proposal — but it is
 * the only route here that spends anything, and it says so.
 */
import { Hono } from "hono";
import { ventureRow } from "../../db.ts";
import { packetFor, measuredKeys } from "./evidence.ts";
import {
  DEFAULT_PER_NIGHT,
  DEFAULT_PER_NIGHT_VENTURES,
  DEFAULT_PER_VENTURE,
  DEFAULT_REPEAT_DAYS,
  coverage,
  passForVenture,
  proposalRows,
  rotation,
  setProposals,
  settings,
  shapeProposal,
} from "./synthesis.ts";

export const synthesisRoutes = new Hono();

function config() {
  const s = settings();
  return {
    ...s,
    defaults: {
      venturesPerNight: DEFAULT_PER_NIGHT_VENTURES,
      perVenture: DEFAULT_PER_VENTURE,
      perNight: DEFAULT_PER_NIGHT,
      repeatDays: DEFAULT_REPEAT_DAYS,
    },
    settingsAt: "/api/plugins/synthesis/config",
  };
}

synthesisRoutes.get("/", (c) => {
  const ventureKey = c.req.query("ventureId") ?? c.req.query("venture") ?? null;
  const v = ventureKey ? ventureRow(ventureKey) : null;
  if (ventureKey && !v) return c.json({ error: "No venture by that id or slug." }, 404);
  const verdict = c.req.query("verdict") ?? null;
  if (verdict && verdict !== "filed" && verdict !== "dropped")
    return c.json({ error: "`verdict` is 'filed' or 'dropped'." }, 400);

  const limit = Number(c.req.query("limit") ?? 50);
  const rows = proposalRows({
    ventureId: v?.id ?? null,
    verdict,
    limit: Number.isFinite(limit) ? limit : 50,
  });

  return c.json({
    config: config(),
    /** Whose turn it is on the next pass, in least-recently-covered order. */
    next: rotation(settings().venturesPerNight),
    /* COVERAGE IS THE NIGHT'S ROTATION AND NOT A LOG OF EVERY PASS. Running the
       pass by hand for one venture deliberately does NOT mark it covered: the
       owner asking a question about a business is not the schedule spending
       that business's turn, and letting it would mean a curious afternoon
       silently pushed three ventures to the back of the queue. */
    coverage: coverage(),
    proposals: rows.map(shapeProposal),
    filed: rows.filter((r) => r.verdict === "filed").length,
    dropped: rows.filter((r) => r.verdict === "dropped").length,
    notes: {
      dropped:
        "A dropped proposal is one the gate refused, with the reason on the row. The commonest " +
        "reasons are that it was already on the board and that it rested on evidence this box does " +
        "not measure for that venture.",
      evidence:
        "`packet` on each row is the evidence AS IT WAS when the proposal was made. It is stored " +
        "rather than re-read, because the figure that justified an action on Tuesday is a different " +
        "figure on Friday.",
      cards:
        "A filed proposal is an ordinary board card in Backlog, tagged in its body as a proposal. " +
        "Nothing has been done; deleting the card is the way to decline it.",
      coverage:
        "`coverage` counts passes the NIGHTLY ROTATION made. A pass run by hand for one venture does " +
        "not mark it covered, so a venture with lastPassAt null may still have proposals against it.",
    },
  });
});

/**
 * THE EVIDENCE PACKET FOR ONE VENTURE, with nothing asked of a model.
 *
 * Free — every field comes out of tables this box already holds — and it is
 * the honest answer to "why does this venture never get a proposal": four of
 * the seven sections say NOT MEASURED with the link that would fix it.
 */
synthesisRoutes.get("/evidence/:key", async (c) => {
  const v = ventureRow(c.req.param("key"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);
  const packet = await packetFor(v.id);
  if (!packet) return c.json({ error: "The evidence packet could not be built." }, 500);
  return c.json({
    packet,
    measured: measuredKeys(packet),
    note:
      "Every section is either a measured figure with its window stated, or null with the reason. " +
      "A proposal that does not rest on one of the measured keys is refused by the gate.",
  });
});

synthesisRoutes.post("/run", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ventureId?: unknown; venture?: unknown; dry?: unknown } | null;
  const key = typeof body?.ventureId === "string" ? body.ventureId : typeof body?.venture === "string" ? body.venture : null;
  if (!key) return c.json({ error: "`ventureId` names the venture to run the pass for." }, 400);
  const v = ventureRow(key);
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);

  const out = await passForVenture(v.id, { runId: null, dry: body?.dry === true });
  return c.json(
    {
      ...out,
      note: out.ran
        ? "The pass ran. Filed proposals are board cards in Backlog; dropped ones are on the proposals page with the gate's reason."
        : "Nothing was asked of the model — see `why`.",
    },
    out.ran ? 201 : 200,
  );
});

/** Proposals on or off for one venture. A portfolio has businesses in it that
 *  are parked or sold, and a global switch would make the owner choose between
 *  proposals for everything and proposals for nothing. */
synthesisRoutes.patch("/ventures/:key", async (c) => {
  const v = ventureRow(c.req.param("key"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);
  const body = (await c.req.json().catch(() => null)) as { proposals?: unknown } | null;
  if (typeof body?.proposals !== "boolean")
    return c.json({ error: "`proposals` is true or false." }, 400);
  setProposals(v.id, body.proposals);
  return c.json({ ventureId: v.id, venture: v.name, proposals: body.proposals });
});
