/**
 * The off-site footprint, read as a matrix: product × source.
 *
 * FOUR STATUSES AND THE READER MUST NOT COLLAPSE THEM TO TWO. `present` and
 * `absent` are answers. `blocked` means we could not look — a WAF, a rate
 * limit, a timeout, or a directory that cannot be asked at all from here — and
 * `error` means the check itself broke. A page that renders `blocked` as a
 * grey "no" is a page telling the owner to go and get listed somewhere he may
 * already be listed.
 *
 * THERE IS NO SCORE ON THIS DOCUMENT. The original collector computes one out
 * of four weighted halves, and three of those halves are the SearXNG sweep
 * this port deliberately does not carry — a score built from the remaining
 * pieces would be a different number wearing the same name. What is here
 * instead is a count of the cells that answered, beside the count of the ones
 * that could not, which is the arithmetic a reader can actually check.
 */
import { Hono } from "hono";
import { configValue } from "../../../db.ts";
import { SOURCES, SOURCE_LABEL, SOURCE_METHOD, parseProducts } from "./sources.ts";
import { presenceRows } from "../db.ts";
import { EVERY_HOURS } from "./collect.ts";

export const presenceRoutes = new Hono();

presenceRoutes.get("/", async (c) => {
  const configured = parseProducts(configValue("presence", "products"));
  const rows = presenceRows();

  const products = configured.map((product) => {
    const mine = rows.filter((r) => r.product === product.name);
    const cells = SOURCES.map((source) => {
      const row = mine.find((r) => r.source === source);
      return {
        source,
        label: SOURCE_LABEL[source],
        method: SOURCE_METHOD[source],
        /** null is "never checked" — a fresh product before its first run. */
        status: row?.status ?? null,
        url: row?.url ?? null,
        /** linked · named · page — see the sources file. `named` on an
         *  `absent` row is a CANDIDATE the owner should judge, not a listing. */
        evidence: row?.evidence ?? null,
        note: row?.note ?? null,
        checkedAt: row?.ts ?? null,
      };
    });
    const count = (s: string) => cells.filter((x) => x.status === s).length;
    return {
      product: product.name,
      host: product.host,
      sources: cells,
      /** Rows that name the brand without pointing back here. Not detections
       *  — the owner's judgement, in front of him rather than in a status. */
      candidates: cells
        .filter((x) => x.evidence === "named" && x.url)
        .map((x) => ({ source: x.source, url: x.url, note: x.note })),
      summary: {
        present: count("present"),
        absent: count("absent"),
        blocked: count("blocked"),
        errored: count("error"),
        unchecked: cells.filter((x) => x.status === null).length,
        of: SOURCES.length,
      },
      checkedAt: mine.map((r) => r.ts).sort().at(-1) ?? null,
    };
  });

  return c.json({
    products,
    sources: SOURCES.map((id) => ({ id, label: SOURCE_LABEL[id], method: SOURCE_METHOD[id] })),
    summary: {
      configured: configured.length,
      checked: products.filter((p) => p.checkedAt).length,
      everyHours: EVERY_HOURS,
      checkedAt: products.map((p) => p.checkedAt).filter(Boolean).sort().at(-1) ?? null,
    },
    /* THE OWNER'S OWN RECORD, BESIDE THE PROBES. Nothing here writes it and
       nothing here can: detection may only ratchet a row forward to
       `detected`, and every state past that means a person looked. The rows
       themselves are at /api/seoops/listings, which is also where they are
       set. */
    listings: await ledgerSummary(),
    notes: [
      "`blocked` means the source could not be asked — a 403, a rate limit, a " +
        "timeout, or a directory with no keyless lookup. Read it as NOT CHECKED. " +
        "It is never a report that the product is unlisted.",
      "`present` from a search-shaped source (GitHub, PyPI, the App Store, " +
        "Hacker News) requires the record to NAME the brand and to POINT BACK at " +
        "the product's own host. A record that only names it is a candidate.",
      "The two directory checks (G2, Product Hunt) fetch the url that name " +
        "would be at. An `absent` from them is about that url, not about the site.",
      "Nothing here is a submission and nothing here counts as done. A found " +
        "page is evidence for the owner to confirm.",
      `Checked once every ${EVERY_HOURS} hours per product.`,
      "`listings` is the OWNER'S ledger, not this matrix. A `present` cell here " +
        "may ratchet a ledger row forward to `detected`; nothing here can ever " +
        "move one back, and only the owner can mark one confirmed, submitted or " +
        "skipped. Set them at /api/seoops/listings.",
    ],
  });
});


/**
 * THE LEDGER'S HEADLINE, THROUGH A GUARDED DYNAMIC IMPORT.
 *
 * A STATIC import of `integrations/seoops/listings.ts` made THIS area's boot
 * depend on THAT area existing: the inner try/catch covered a missing table
 * and could not cover a missing module, so a checkout without seoops would not
 * have loaded presence at all. The areas are deliberately independent — this
 * one measures the probes, that one holds the owner's record of what they did
 * about them — and the dependency belongs at the call, where its absence is a
 * `null` on one key rather than a server that will not start.
 *
 * Null means "the ledger is not on this box", which is a different answer from
 * an empty ledger and is drawn as one.
 */
async function ledgerSummary(): Promise<unknown> {
  try {
    const { shapeLedger } = await import("../../seoops/listings.ts");
    const ledger = shapeLedger();
    return {
      directories: ledger.catalogue.count,
      detectable: ledger.catalogue.detectable,
      confirmed: ledger.ventures.reduce((n, v) => n + v.summary.confirmed, 0),
      submitted: ledger.ventures.reduce((n, v) => n + v.summary.submitted, 0),
      detected: ledger.ventures.reduce((n, v) => n + v.summary.detected, 0),
      skipped: ledger.ventures.reduce((n, v) => n + v.summary.skipped, 0),
      notListed: ledger.ventures.reduce((n, v) => n + v.summary.notListed, 0),
      /* ONLY THE VENTURES WITH A ROW SOMEBODY HAS TOUCHED. A portfolio of
         twenty would otherwise put twenty identical all-zero summaries on a
         document that is about the probes. The full matrix is at
         /api/seoops/listings. */
      worked: ledger.ventures
        .filter((v) => v.summary.of - v.summary.notListed > 0)
        .map((v) => ({ ventureId: v.ventureId, venture: v.venture, slug: v.slug, summary: v.summary })),
      venturesWithNothingRecorded: ledger.ventures.filter((v) => v.summary.of === v.summary.notListed).length,
      where: "/api/seoops/listings",
    };
  } catch {
    /* No seoops area on this box, or its migrations have not run. Answered as
       null rather than as a failure of this document, which is about probes. */
    return null;
  }
}

/** The host is the entity: a venture with that host is obviously about it. */
presenceRoutes.get("/entities", (c) => {
  const configured = parseProducts(configValue("presence", "products"));
  return c.json({
    entities: configured.map((p) => ({
      plugin: "presence",
      entity: p.host,
      label: `${p.name} (${p.host})`,
      host: p.host,
    })),
  });
});
