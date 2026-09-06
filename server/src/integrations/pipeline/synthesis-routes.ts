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
 * `POST /run` COSTS REAL MONEY and `POST /plan` cannot. One model call per
 * venture, against the whole evidence packet. `/run` refuses the word `dry`
 * outright and names `/plan`; `/plan` hard-codes it and reads nothing from the
 * request. Two routes rather than a boolean, because the skills proxy sends
 * every parameter as a STRING and a route testing `body.dry === true` reads
 * `"true"` as false — the bug that published a real Facebook post in wave 1 of
 * this build, and the bug this route had until it was reviewed.
 *
 * `/run` is not marked destructive — filing a board card is reversible, and the
 * card says on its face that it is a proposal — but it is the only route here
 * that spends anything, and it says so.
 */
import { Hono, type Context } from "hono";
import { ventureRow } from "../../db.ts";
import { readBool, refuseDry } from "./params.ts";
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

  /* THE STORED PACKETS ARE OFF BY DEFAULT. Each one is the whole evidence
     document the model saw — kilobytes — and the venture Overview asks for
     twelve rows on every render. The list carries the evidence LINE, which is
     what a reader needs; ask for `packet=full` (or read one proposal) when the
     question is "what exactly was it looking at". */
  const withPacket = (c.req.query("packet") ?? "").trim().toLowerCase() === "full";

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
    proposals: rows.map((r) => shapeProposal(r, { packet: withPacket })),
    filed: rows.filter((r) => r.verdict === "filed").length,
    dropped: rows.filter((r) => r.verdict === "dropped").length,
    notes: {
      dropped:
        "A dropped proposal is one the gate refused, with the reason on the row. The commonest " +
        "reasons are that it was already on the board and that it rested on evidence this box does " +
        "not measure for that venture.",
      evidence:
        "`evidenceLine` on each row is the figure the proposal rests on, quoted from the packet at " +
        "the time. The whole packet is stored too but is NOT returned by default — add `packet=full` " +
        "for it. Either way it is a snapshot: the figure that justified an action on Tuesday is a " +
        "different figure on Friday, so never quote it as the current number.",
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

/** Shared by `/run` and `/plan`, which differ in exactly one hard-coded
 *  argument. Neither reads `dry` from anywhere. */
async function pass(c: Context, dry: boolean) {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  if (!dry) {
    const refusal = refuseDry(body, "POST /api/synthesis/plan");
    if (refusal) return c.json({ error: refusal }, 400);
  }

  const key =
    typeof body?.ventureId === "string" ? body.ventureId : typeof body?.venture === "string" ? body.venture : null;
  if (!key) return c.json({ error: "`ventureId` names the venture to run the pass for." }, 400);
  const v = ventureRow(key);
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);

  const out = await passForVenture(v.id, { runId: null, dry });
  return c.json(
    {
      ...out,
      note: dry
        ? "Nothing was asked of the model and nothing was filed. `packet` is the evidence as it stands."
        : out.ran
          ? "The pass ran. Filed proposals are board cards in Backlog; dropped ones are on the proposals page with the gate's reason."
          : "Nothing was asked of the model — see `why`.",
    },
    out.ran ? 201 : 200,
  );
}

/** RUN IT, FOR REAL. One model call over the whole packet, and board cards for
 *  whatever survives the gate. It refuses a `dry` field rather than parsing
 *  one — see the file header. */
synthesisRoutes.post("/run", (c) => pass(c, false));

/** REHEARSE IT. `dry` is the literal `true` below and comes from nowhere else,
 *  so there is no request this route can receive that asks a model anything. */
synthesisRoutes.post("/plan", (c) => pass(c, true));

/** Proposals on or off for one venture. A portfolio has businesses in it that
 *  are parked or sold, and a global switch would make the owner choose between
 *  proposals for everything and proposals for nothing. */
synthesisRoutes.patch("/ventures/:key", async (c) => {
  const v = ventureRow(c.req.param("key"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  /* Through `readBool`, which takes the STRING the skills proxy sends. This
     route used to demand `typeof === "boolean"` and so answered 400 to every
     call an agent could make: the action could never once succeed. */
  const read = readBool(body?.proposals, "proposals");
  if (!read.ok) return c.json({ error: read.error }, 400);
  setProposals(v.id, read.value === true);
  return c.json({ ventureId: v.id, venture: v.name, proposals: read.value === true });
});
