import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_BUILDERS, domUse, type LiveInputs } from "./liveWidgets.ts";

const build = (key: string, data: Record<string, unknown>) =>
  LIVE_BUILDERS[key]!({ points: [], domains: [], domainSummary: null, ...data } as unknown as LiveInputs);

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const dom = (name: string, days: number | null, extra: Record<string, unknown> = {}) => ({
  name,
  source: "dynadot",
  registrar: "Dynadot",
  account: "Account 1",
  accountId: 1,
  expiresAt: days === null ? null : inDays(days),
  expiresInDays: days,
  registeredOn: "2025-01-02",
  autoRenew: true,
  locked: true,
  status: "active",
  privacy: "full",
  nameservers: ["a.ns.cloudflare.com"],
  seenAt: "",
  ...extra,
});
const expense = (name: string, annual: number | null, confidence: string | null = null) => ({
  id: name, label: name, category: "domain", archived: false, sourceRef: `dynadot:${name}`,
  amount: annual, annual, currency: "USD", period: "yearly", confidence,
});

test("an unpriced name is left out of the yearly cost, not counted as free", () => {
  const domains = [dom("a.co", 40), dom("b.co", 90)];
  const p = build("domains.yearly", { domains, finance: { expenses: [expense("a.co", 31.2), expense("b.co", null)] } })!;
  assert.match(p.value!, /31/);
  assert.match(p.sub!, /1 unpriced/);
  assert.equal(build("domains.yearly", { domains }), null, "no ledger, no card");
});

test("renewals land in their month, with human dates on the next renewal", () => {
  const domains = [dom("a.co", 40, { autoRenew: false }), dom("b.co", 40)];
  const finance = { expenses: [expense("a.co", 10), expense("b.co", 20, "estimated")] };
  const r = build("domains.renewals", { domains, finance })!;
  assert.equal(r.daily!.length, 13);
  assert.equal(r.daily!.reduce((n, d) => n + d.total, 0), 30);
  assert.ok(r.daily!.every((d) => d.tick && !/Sept/.test(d.label!)));
  const n = build("domains.next", { domains, finance })!;
  assert.equal(n.value, "40 days");
  assert.match(n.sub!, /a\.co \+1/);
  assert.match(n.sub!, /auto-renew off/);
});

test("a name nobody can see is not measured, never parked", () => {
  assert.equal(domUse("x.com", null, null), "unmeasured");
  const zone = (requests: number, pageViews: number | null, s3xx = 0) => ({
    cloudflare: { zones: [{ name: "x.com", traffic: { requests, pageViews, days: 30, status: { s2xx: 0, s3xx, s4xx: 0, s5xx: 0 } } }] },
  });
  assert.equal(domUse("x.com", zone(1000, 900).cloudflare as never, null), "live");
  assert.equal(domUse("x.com", zone(1000, 0, 900).cloudflare as never, null), "redirect");
  assert.equal(domUse("x.com", zone(4, 0).cloudflare as never, null), "parked");
  const up = { hosts: [{ host: "x.com", current: { ok: true } }] };
  assert.equal(domUse("x.com", null, up as never), "live");
});

test("the checklist is one row per name, worst reason first", () => {
  const domains = [dom("a.co", 60, { autoRenew: false, nameservers: null }), dom("b.co", 300)];
  const t = build("domains.attention", { domains })!;
  assert.equal(t.table!.length, 1);
  assert.match(t.table![0]![1]!, /^Renew or let go · No DNS/);
  assert.match(t.table![0]![2]!, /^in 60 days · /);
});
