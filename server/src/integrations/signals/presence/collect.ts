/**
 * Presence, collected — once per configured product, once a day.
 *
 * A DAY CLOCK PER PRODUCT, for the backlinks collector's reason and one of
 * its own: an encyclopedia article does not appear between breakfast and
 * lunch, and every request here goes to somebody else's free service. A
 * product NOTHING HAS EVER ASKED ABOUT is checked immediately whatever the
 * clock says, so a list saved at nine is a matrix at nine.
 *
 * ONE SOURCE'S FAILURE IS ONE CELL. Nine sources, nine rows, each with its
 * own status and its own timestamp — a GitHub rate limit does not touch the
 * Wikipedia cell beside it, and it certainly does not write eight `absent`s.
 * The run fails only when a product got nothing but blocks and errors from
 * every one of the nine.
 *
 * SEQUENTIAL ON PURPOSE. One request at a time across the whole run, with a
 * gap between them. Nine sources times a handful of products is a slow minute
 * and nobody is waiting on it; a parallel sweep would be nine simultaneous
 * requests to nine strangers from one IP, which is how a free endpoint decides
 * it does not like this box.
 */
import { configValue, finishRun, startRun, upsertPlugin } from "../../../db.ts";
import type { CollectResult } from "../../manifest.ts";
import {
  Pace,
  SOURCES,
  appstore,
  capterra,
  g2,
  github,
  hackernews,
  needles,
  parseProducts,
  producthunt,
  pypi,
  wikidata,
  wikipedia,
  type Finding,
  type Product,
  type SourceId,
} from "./sources.ts";
import { forgetPresenceProducts, presenceLastRun, writePresence } from "../db.ts";

export const PLUGIN = "presence";
export const EVERY_HOURS = 24;

/** The whole run's wall clock — the scheduler's interval is thirty minutes
 *  and a collection that outlives it is two collections racing. */
const RUN_MS = 10 * 60_000;

/**
 * GitHub's unauthenticated search allows ten requests a minute and this file
 * holds no token; seven seconds is inside that with room for a retry. Every
 * other source is asked once per product per day and gets the polite default.
 */
const GITHUB_GAP_MS = 7_000;
const GAP_MS = 300;

export type PresenceSummary = CollectResult & {
  runId: number;
  products: number;
  collected: number;
  skipped: number;
  warnings: string[];
};

export async function collectPresence(): Promise<PresenceSummary> {
  const runId = startRun(PLUGIN);
  const products = parseProducts(configValue(PLUGIN, "products"));

  if (!products.length) {
    const error =
      "No products configured. Presence needs no key, but it does need to know " +
      "what to look for — one `Name = host` per line on the plugin page.";
    finishRun(runId, false, undefined, error);
    upsertPlugin(PLUGIN, false, error);
    return { ok: false, runId, products: 0, collected: 0, skipped: 0, warnings: [], error };
  }

  forgetPresenceProducts(products.map((p) => p.name));

  const due = products.filter((p) => {
    const at = presenceLastRun(p.name);
    return !at || Date.now() - Date.parse(at) >= EVERY_HOURS * 3_600_000;
  });

  if (!due.length) {
    const note = `fresh — all ${products.length} product(s) checked inside the last ${EVERY_HOURS}h`;
    finishRun(runId, true, note);
    upsertPlugin(PLUGIN, true, null);
    return {
      ok: true, runId, products: products.length, collected: 0,
      skipped: products.length, warnings: [], note,
    };
  }

  const deadline = Date.now() + RUN_MS;
  const pace = new Pace(GAP_MS);
  const githubPace = new Pace(GITHUB_GAP_MS);
  const warnings: string[] = [];
  let worked = 0;
  let found = 0;

  for (const product of due) {
    if (Date.now() >= deadline) {
      warnings.push(`${product.name}: the run's clock ran out before it was reached`);
      continue;
    }
    const ns = needles(product);
    let answered = 0;

    for (const source of SOURCES) {
      if (Date.now() >= deadline) break;
      await (source === "github" ? githubPace : pace).wait();

      let finding: Finding;
      try {
        finding = await ask(source, product, ns);
      } catch (err) {
        // A source that dies takes its own cell and nothing else.
        finding = {
          status: "error",
          url: null,
          evidence: null,
          note: `the check raised ${err instanceof Error ? err.name : "an error"}`,
        };
      }
      writePresence({
        product: product.name,
        host: product.host,
        source,
        status: finding.status,
        url: finding.url,
        evidence: finding.evidence,
        note: finding.note,
      });
      if (finding.status === "present") found += 1;
      if (finding.status === "present" || finding.status === "absent") answered += 1;
      else if (finding.status === "error") warnings.push(`${product.name} · ${source}: ${finding.note}`);
    }

    if (answered) worked += 1;
    else warnings.push(`${product.name}: no source could be asked`);
  }

  const note =
    `${worked}/${due.length} product(s) checked across ${SOURCES.length} sources, ` +
    `${found} page(s) found` +
    (products.length - due.length ? `, ${products.length - due.length} fresh` : "");

  const allFailed = worked === 0;
  finishRun(runId, !allFailed, note, warnings.join("; ") || undefined);
  upsertPlugin(PLUGIN, true, allFailed ? warnings.join("; ") || "nothing answered" : null);

  return {
    ok: !allFailed,
    runId,
    products: products.length,
    collected: worked,
    skipped: products.length - due.length,
    warnings,
    note,
    error: allFailed ? warnings.join("; ") || "nothing answered" : null,
  };
}

function ask(source: SourceId, product: Product, ns: string[]): Promise<Finding> {
  switch (source) {
    case "wikipedia": return wikipedia(product);
    case "wikidata": return wikidata(product);
    case "github": return github(product, ns);
    case "pypi": return pypi(product, ns);
    case "appstore": return appstore(product, ns);
    case "hackernews": return hackernews(product, ns);
    case "producthunt": return producthunt(product, ns);
    case "g2": return g2(product, ns);
    case "capterra": return capterra();
  }
}
