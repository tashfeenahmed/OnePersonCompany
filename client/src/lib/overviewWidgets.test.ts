import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_BUILDERS, type LiveInputs } from "./liveWidgets.ts";
import { WIDGETS } from "../data/widgets.ts";
import { measuredWidget } from "./widgetView.ts";
import { cycleWidgetWidth, widgetSpan } from "./widgetLayout.ts";
import { isWorkspacePreferences } from "../../../shared/workspace.ts";
const build = (key: string, data: Record<string, unknown>) => LIVE_BUILDERS[key]!({points:[], ...data} as LiveInputs);

test("overview cards stay empty without measurements, including their inherited catalog samples", () => {
  for (const [key, base] of Object.entries(WIDGETS).filter(([k])=>k.startsWith("brief."))) {
    const patch = build(key, {});
    assert.equal(patch, null, key);
    const result = measuredWidget(base, patch);
    assert.equal(result.value, undefined, key);
    assert.equal(result.series, undefined, key);
    assert.equal(result.presentation, base.presentation, key);
  }
});
test("net card accounts for exactly its ledger gross and keeps sterling", () => {
  const p=build("brief.net",{window:7,stripe:{revenue:[{currency:"GBP",gross:1000,net:800,series:[]} ]}})!;
  assert.match(p.name!,/7d/);
  assert.match(p.value!,/£800/);
  assert.deepEqual(p.parts?.map(p=>p.value),[200,800]);
  assert.match(p.caption!,/Stripe ledger only/);
  const loss=build("brief.net",{stripe:{revenue:[{currency:"GBP",gross:100,net:-20,series:[]}]}})!;
  assert.deepEqual(loss.parts,[],"negative net is not a positive share");
});
test("traffic widgets respect Umami's fixed window and preserve total views in the split", () => {
  const websites=Array.from({length:5},(_,i)=>({name:`site${i}`,domain:`site${i}.com`,window:{pageviews:(i+1)*100,visitors:20}}));
  const umami={portfolio:{answering:5,window:{days:30,pageviews:1500},days:[]},websites};
  const p=build("brief.views",{window:7,umami})!;
  assert.equal(p.name,"Views · 30d");
  assert.equal(p.parts?.reduce((n,p)=>n+p.value,0),1500);
  assert.equal(p.parts?.length,4);
  assert.equal(p.parts?.at(-1)?.label,"Other sites");
  const traffic=build("brief.traffic",{umami})!;
  assert.equal(traffic.dumbbell?.length,5);
  assert.deepEqual(traffic.names,["Visitors","Pageviews"]);
});
test("unlike Play payout currencies never share a ranked bar scale",()=>{
  const p=build("brief.play",{mobile:{play:{connected:true,packages:[{package:"com.one.app",payout:[{amount:20,currency:"USD"},{amount:30,currency:"EUR"}]}]}}})!;
  assert.deepEqual(p.ranked,[]);
  assert.equal(p.rows?.length,2);
  assert.match(p.caption!,/original currencies/);
});
test("a resized third-width card persists through the shared workspace contract",()=>{
  const def=WIDGETS["brief.arr"]!;
  const initial={id:"w",type:"brief.arr",w:2 as const};
  assert.equal(widgetSpan(initial,def),4);
  const resized={...initial,...cycleWidgetWidth(initial,def)};
  assert.equal(widgetSpan(resized,def),5);
  assert.equal(widgetSpan({w:1}),3,"existing quarter widths are preserved");
  const prefs={workspace:{name:"Test",owner:"Owner"},sessions:[],dashboards:[{id:"d",name:"Test",slug:"test",widgets:[resized]}]};
  assert.equal(isWorkspacePreferences(prefs),true);
  assert.equal(isWorkspacePreferences({...prefs,dashboards:[{...prefs.dashboards[0],widgets:[{...resized,span:13}]}]}),false);
});
test("missing traffic measurements are omitted, not plotted as zero",()=>{
  const missing={name:"Missing",domain:"missing.test",window:{visitors:null,pageviews:100}};
  const known={name:"Known",domain:"known.test",window:{visitors:20,pageviews:100}};
  const p=build("brief.traffic",{umami:{portfolio:{window:{days:30}},websites:[missing,known]}})!;
  assert.equal(p.dumbbell?.length,1);
  assert.equal(p.dumbbell?.[0]?.a,20);
});

/**
 * THE MARGIN CARD USED TO ADD THE VENTURE ROWS UP, and the venture rows are
 * the ALLOCATED half of the revenue. A month whose Stripe cash bought products
 * nobody had linked read as a dollar earned against thousands collected. The
 * portfolio publishes its own total now; these hold the card to it.
 */
const portfolio = (over: Record<string, unknown> = {}) => ({
  month: "2026-08",
  actual: true,
  ventures: [
    { venture: { id: "v1", slug: "a", name: "A", stage: "launched" }, margin: [{ currency: "USD", revenue: 180, cost: 20, margin: 160 }] },
  ],
  revenue: {
    allocated: { amounts: [{ currency: "USD", amount: 180 }], unpriced: 0, combined: null },
    unallocated: [{ currency: "USD", amount: 80, charges: 3, note: "three charges named no venture." }],
    total: { amounts: [{ currency: "USD", amount: 260 }], unpriced: 0, combined: null },
    basis: "Revenue is settled money, not billings.",
  },
  ledger: {
    monthly: { amounts: [{ currency: "USD", amount: 20 }], unpriced: 0, combined: null },
    unallocatedShared: { amounts: [{ currency: "USD", amount: 5 }], unpriced: 0, combined: null },
    unallocatedLines: [{ expenseId: "e1", label: "Box", currency: "USD", monthly: 5, allocated: 0 }],
    defaultRule: "none",
  },
  modelSpend: { usd: 3, tokens: 1000, calls: 2, estimatedCalls: 0, note: "" },
  power: [],
  rules: [],
  ...over,
});

test("the margin card reads the portfolio's own revenue total, not the sum of the venture rows", () => {
  const p = build("overview.margin", { profit: portfolio() })!;
  /* $260 settled, of which $180 reached a venture. The old arithmetic drew
     $180 and called it the month's revenue. */
  assert.match(p.value!, /\$235/, "260 earned less 25 spent");
  assert.deepEqual(p.parts?.map((x) => x.value), [260, 25]);
  const rows = new Map(p.rows as [string, string][]);
  assert.match(rows.get("Net revenue")!, /\$260/);
  assert.match(rows.get("Revenue, allocated to a venture")!, /\$180/);
  const missing = rows.get("Revenue, not attributed to a venture")!;
  assert.match(missing, /\$80/);
  assert.match(missing, /3 charges/);
  assert.match(missing, /fees/);
  assert.match(p.caption!, /settled money/);
});

test("a portfolio whose every charge reached a venture gets no unattributed row", () => {
  const whole = portfolio({
    revenue: {
      allocated: { amounts: [{ currency: "USD", amount: 180 }], unpriced: 0, combined: null },
      unallocated: [],
      total: { amounts: [{ currency: "USD", amount: 180 }], unpriced: 0, combined: null },
      basis: "",
    },
  });
  const rows = new Map(build("overview.margin", { profit: whole })!.rows as [string, string][]);
  assert.equal(rows.has("Revenue, not attributed to a venture"), false);
  assert.match(rows.get("Net revenue")!, /\$180/);
});

test("the runway row says what Stripe is holding where a balance was collected, and never divides it", () => {
  const summary = {
    monthly: { amounts: [{ currency: "USD", amount: 20 }], unpriced: 0, combined: null },
    stripeBalance: {
      currencies: [{ currency: "USD", available: 900, pending: 100 }],
      seenAt: new Date().toISOString(),
    },
  };
  const rows = new Map(
    build("overview.margin", { profit: portfolio(), finance: { summary } })!.rows as [string, string][],
  );
  const runway = rows.get("Runway")!;
  assert.match(runway, /\$900\.00 available/);
  assert.match(runway, /\$100\.00 pending/);
  assert.match(runway, /not a runway/);

  /* Stale is worse than absent: a fortnight-old balance read as what is in the
     account. The sentence that makes no claim comes back. */
  const stale = {
    ...summary,
    stripeBalance: {
      ...summary.stripeBalance,
      seenAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    },
  };
  const old = new Map(
    build("overview.margin", { profit: portfolio(), finance: { summary: stale } })!.rows as [string, string][],
  );
  assert.equal(old.get("Runway"), "not computed — this box holds no cash balance");
  /* And with no Stripe account at all. */
  const none = new Map(build("overview.margin", { profit: portfolio() })!.rows as [string, string][]);
  assert.equal(none.get("Runway"), "not computed — this box holds no cash balance");
});
