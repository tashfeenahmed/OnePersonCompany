/**
 * The domain portfolio, as EVERY connected registrar sees it.
 *
 * ONE ROUTE FOR THE WHOLE PAGE. A domains dashboard asks the same question of
 * the same list from a dozen cards — the runway, the counts, the table, the
 * TLD split — and a dozen requests for one answer is a burst the box does not
 * need to serve.
 *
 * THE COUNTDOWNS ARE COMPUTED HERE, EVERY TIME. Nothing in the database says
 * "expires in 30 days"; it says "expires on 2026-10-04", and the days are
 * worked out against today at the moment of the read. A stored countdown is
 * wrong by one the next morning, and wrong by a month if a collection fails for
 * a month — which is exactly the situation in which a renewal dashboard has to
 * be right.
 *
 * NULL IS A THIRD ANSWER THROUGHOUT. A registrar that does not report
 * auto-renew is not a registrar reporting auto-renew off, and the counts keep
 * the two apart: `autoRenewOff` is a list of things to fix, `autoRenewUnknown`
 * is a list of things nobody can vouch for. Folding them together turns the
 * first into a number too big to act on.
 */
import { Hono } from "hono";
import { daysUntil, registeredDomains } from "../providers/domains.ts";

export const domains = new Hono();

/** The two lines a renewal is judged against, in one place. A week is when a
 *  lapse becomes a thing to do today; a month is roughly where it stops being
 *  a card update and starts being a redemption fee. */
export const EXPIRY = { crit: 7, warn: 30 } as const;

/**
 * Known two-label suffixes, so `thing.co.uk` groups under `co.uk` and not
 * under `uk` beside a name that really is a `.uk`.
 *
 * A short list rather than the public suffix list: this groups a personal
 * portfolio into a bar chart, and shipping a 15,000-line dataset (that goes
 * stale) to decide whether two names share a registry is the wrong trade. A
 * suffix not on the list falls back to its last label, which is right for every
 * single-label TLD and the reason the fallback is safe.
 */
const TWO_LABEL = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk",
  "com.au", "net.au", "org.au", "co.nz", "net.nz", "org.nz",
  "co.za", "com.br", "com.mx", "co.in", "co.jp", "com.sg", "com.tr",
]);

function tld(name: string): string {
  const parts = name.split(".");
  if (parts.length >= 3) {
    const two = parts.slice(-2).join(".");
    if (TWO_LABEL.has(two)) return two;
  }
  return parts[parts.length - 1] ?? "";
}

domains.get("/", (c) => {
  /* NOT `allDomains()`, WHICH IS ONLY THE `domains` TABLE. A name registered
     at Cloudflare is collected into a second table of its own, and while this
     route read the first one only, every number below — the total, the lapsed
     and expiring counts, auto-renew-off, unlocked, the runway — silently left
     those names out. `registeredDomains()` is the one reader both this page
     and the Cloudflare page go through. */
  const rows = registeredDomains();
  const now = new Date();

  const list = rows.map((r) => ({
    name: r.name,
    source: r.source,
    /* WHICH LOGIN THIS NAME WAS READ THROUGH. A portfolio merged across two
       Dynadot accounts is still one portfolio to the person renewing it, but
       "where do I go to change this" is a question only the account answers. */
    accountId: r.account_id,
    account: r.account_label,
    registrar: r.registrar,
    expiresAt: r.expires_at,
    expiresInDays: daysUntil(r.expires_at, now),
    registeredOn: r.registered_on,
    autoRenew: r.auto_renew === null ? null : r.auto_renew === 1,
    locked: r.locked === null ? null : r.locked === 1,
    status: r.status,
    privacy: r.privacy,
    nameservers: r.nameservers ? (JSON.parse(r.nameservers) as string[]) : null,
    seenAt: r.seen_at,
  }));

  const dated = list.filter((d) => d.expiresInDays !== null);

  /*
    LAPSED IS NOT "EXPIRING". A name whose date has passed is counted by
    `lapsed` and by nothing else: rolling it into "1 renewing this week" would
    let the most urgent row on the page hide inside a number that also means
    "there is a week to sort this out". They are different mornings.
  */
  const within = (days: number) =>
    dated.filter((d) => d.expiresInDays! >= 0 && d.expiresInDays! <= days).length;

  const byRegistrar: Record<string, number> = {};
  const byTld: Record<string, number> = {};
  /* Keyed by registrar AND account, because two Dynadot logins are two
     answers to "where is this name" and one line reading "Dynadot 19" when
     the 19 came from two places is a merge nobody asked for. */
  const byAccount: Record<string, number> = {};
  for (const d of list) {
    byRegistrar[d.registrar] = (byRegistrar[d.registrar] ?? 0) + 1;
    const key = `${d.registrar} · ${d.account}`;
    byAccount[key] = (byAccount[key] ?? 0) + 1;
    const suffix = tld(d.name);
    if (suffix) byTld[suffix] = (byTld[suffix] ?? 0) + 1;
  }

  const soonest = [...dated].sort((a, b) => a.expiresInDays! - b.expiresInDays!)[0] ?? null;

  return c.json({
    domains: list,
    summary: {
      total: list.length,
      byRegistrar,
      byAccount,
      /** How many accounts this portfolio is the sum of. One is a portfolio;
       *  more than one is a portfolio that says so. */
      accounts: Object.keys(byAccount).length,
      byTld,
      /** Already past their date. A registrar can still hold a name in
       *  redemption, so this is a finding rather than an absence. */
      lapsed: dated.filter((d) => d.expiresInDays! < 0).length,
      expiring7: within(EXPIRY.crit),
      expiring30: within(EXPIRY.warn),
      expiring90: within(90),
      autoRenewOff: list.filter((d) => d.autoRenew === false).length,
      autoRenewUnknown: list.filter((d) => d.autoRenew === null).length,
      unlocked: list.filter((d) => d.locked === false).length,
      lockUnknown: list.filter((d) => d.locked === null).length,
      privacyOff: list.filter((d) => d.privacy === "off").length,
      withoutExpiry: list.length - dated.length,
      soonest: soonest && { name: soonest.name, days: soonest.expiresInDays },
      thresholds: EXPIRY,
      seenAt: rows[0]?.seen_at ?? null,
    },
  });
});
