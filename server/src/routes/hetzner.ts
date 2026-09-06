import { Hono } from "hono";
import { db, loadSince } from "../db.ts";
import { hetznerMonthlyCost } from "../integrations/finance/expenses.ts";
import { money } from "../shared/money.ts";

export const hetznerRoutes = new Hono();

type ServerRow = {
  id: number;
  token_label: string;
  account_id: number | null;
  cores: number | null;
  name: string | null;
  ipv4: string | null;
  status: string | null;
  plan: string | null;
  specs: string | null;
  location: string | null;
  monthly_eur: number | null;
  ipv4_monthly_eur: number | null;
  created_at: string | null;
  seen_at: string;
};

type VolumeRow = {
  id: number;
  token_label: string;
  account_id: number | null;
  name: string | null;
  size_gb: number | null;
  location: string | null;
  server_id: number | null;
  monthly_eur: number | null;
};

/** Whatever the last successful collection wrote. Never a live API call: a
 *  page load must not depend on Hetzner being up. */
hetznerRoutes.get("/servers", (c) => {
  const rows = db
    .prepare("SELECT * FROM hetzner_servers ORDER BY name")
    .all() as unknown as ServerRow[];

  return c.json({
    servers: rows.map((r) => ({
      id: r.id,
      /* WHICH ACCOUNT THIS BOX CAME THROUGH. The id is what still points at
         the account after a rename; the label is what it was called when the
         row was written. Null on both is a row collected before accounts
         existed, and it lasts exactly one collection. */
      accountId: r.account_id,
      accountLabel: r.token_label,
      name: r.name,
      ipv4: r.ipv4,
      status: r.status,
      plan: r.plan,
      specs: r.specs,
      location: r.location,
      monthlyEur: r.monthly_eur,
      ipv4MonthlyEur: r.ipv4_monthly_eur,
      createdAt: r.created_at,
    })),
    seenAt: rows[0]?.seen_at ?? null,
  });
});

hetznerRoutes.get("/summary", (c) => {
  const servers = db
    .prepare("SELECT * FROM hetzner_servers")
    .all() as unknown as ServerRow[];
  const volumes = db
    .prepare("SELECT * FROM hetzner_volumes")
    .all() as unknown as VolumeRow[];

  /*
    THE MONEY COMES FROM THE LEDGER, NOT FROM `monthly_eur ?? 0`.

    This route used to add the provider table up itself and treat a plan
    Hetzner quotes no price for as costing nothing — a confident low number,
    published beside a ledger that reported the smaller priced total plus
    `unpriced: n`. And the moment the owner corrected a price in the ledger,
    `owner_fields` pinned it there and this route went on reading the column
    the correction was made ABOUT, so the two disagreed permanently. One
    accessor now, and this document reports its shape: the priced part, how
    many rows have no price, and how many prices are the owner's.
  */
  const ledger = hetznerMonthlyCost();
  const eur = (ref: string) => ledger.byRef.get(ref)?.amount ?? null;
  const serverCost = servers.reduce((n, s) => n + (eur(`server:${s.id}`) ?? 0), 0);
  const volumeCost = volumes.reduce((n, v) => n + (eur(`volume:${v.id}`) ?? 0), 0);

  const byLocation: Record<string, number> = {};
  for (const s of servers) {
    const k = s.location ?? "unknown";
    byLocation[k] = (byLocation[k] ?? 0) + 1;
  }

  /*
    THE SPLIT BY ACCOUNT, so a total can say what it is a total OF.
    A fleet page that adds two projects into one figure without saying so has
    changed what "the bill" means without telling anyone — and the moment a
    second account is added, every number above becomes a sum. This is what
    lets a card say "across 2 accounts" instead of quietly meaning it.
  */
  const byAccount = new Map<
    string,
    { id: number | null; label: string; servers: number; volumes: number; monthlyEur: number; unpriced: number }
  >();
  const bucket = (id: number | null, label: string) => {
    const k = String(id ?? label);
    let b = byAccount.get(k);
    if (!b) byAccount.set(k, (b = { id, label, servers: 0, volumes: 0, monthlyEur: 0, unpriced: 0 }));
    return b;
  };
  for (const s of servers) {
    const b = bucket(s.account_id, s.token_label);
    b.servers += 1;
    const amount = eur(`server:${s.id}`);
    if (amount === null) b.unpriced += 1;
    else b.monthlyEur += amount;
  }
  for (const v of volumes) {
    const b = bucket(v.account_id, v.token_label);
    b.volumes += 1;
    const amount = eur(`volume:${v.id}`);
    if (amount === null) b.unpriced += 1;
    else b.monthlyEur += amount;
  }

  return c.json({
    servers: servers.length,
    running: servers.filter((s) => s.status === "running").length,
    volumes: volumes.length,
    // Net of VAT, in EUR, because that is what Hetzner's API returns.
    monthlyEur: money(serverCost + volumeCost),
    serverMonthlyEur: money(serverCost),
    volumeMonthlyEur: money(volumeCost),
    /** Rows whose price nobody has established. The total above is a FLOOR by
     *  exactly this many lines — never read it as the whole bill when this is
     *  not zero. */
    unpriced: ledger.unpriced,
    unpricedLabels: ledger.unpricedLabels,
    /** Prices the owner corrected in the ledger. A refresh leaves them alone,
     *  and they are the figures on this document. */
    ownerPriced: ledger.ownerPriced,
    basis:
      ledger.rows.length === 0
        ? "The finance ledger holds no Hetzner rows yet — the seed refresh has not run since this account was connected, so no price can be reported for the fleet."
        : "The finance ledger's own monthly run rate for these servers and volumes, net of VAT. An unpriced plan is excluded and counted in `unpriced`, never added as zero; a price the owner corrected is theirs and survives every refresh.",
    byLocation,
    accounts: [...byAccount.values()]
      .sort((a, b) => b.monthlyEur - a.monthlyEur)
      .map((a) => ({ ...a, monthlyEur: money(a.monthlyEur) })),
    seenAt: servers[0]?.seen_at ?? null,
  });
});

/* ----------------------------------------------------------------- load */

type Stat = {
  /** The most recent sample. Named "now" everywhere it is drawn, and it is a
   *  sample rather than a live reading — up to fifteen minutes old. */
  now: number | null;
  mean: number | null;
  peak: number | null;
};

function stat(values: number[]): Stat {
  if (!values.length) return { now: null, mean: null, peak: null };
  return {
    now: values[values.length - 1]!,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    peak: Math.max(...values),
  };
}

const round = (n: number | null, dp = 1) =>
  n === null ? null : Number(n.toFixed(dp));

/**
 * What the fleet has been doing.
 *
 * ONE REQUEST FOR THE WHOLE PAGE. A servers dashboard asks the same question
 * of the same window from a dozen cards — the fleet line, the meters, the
 * table of figures — and a dozen requests for one answer is a burst the box
 * does not need to serve.
 *
 * CPU IS DIVIDED BY THE BOX'S CORES BEFORE IT LEAVES HERE. Hetzner reports
 * CPU summed across cores, so a two-vCPU box flat out reads 200 and this
 * fleet's real peaks include 138.2 and 128.9. Handed to a meter with lines at
 * 75 and 90 that is not a busy box, it is a nonsense scale — and comparing a
 * raw 60 on a two-core box with a raw 60 on a four-core one compares two
 * different fractions of two different machines. Divided by cores, every
 * figure on the page is the same thing: how much of THAT box is in use, out of
 * 100. A box whose core count is unknown is passed through undivided and says
 * so, rather than being quietly scaled by a guess.
 *
 * The FLEET's CPU line is a MEAN across the boxes reporting at that moment,
 * never a sum: the boxes are different sizes, and adding seven percentages
 * produces a number in no unit at all. A moment where a box did not report is
 * averaged over the ones that did, so a fleet that grew inside the window does
 * not draw the earlier absence as a collapse in load. Bandwidth is the other
 * way round and is SUMMED — bytes a second do add up.
 */
hetznerRoutes.get("/load", (c) => {
  const hours = Math.min(Math.max(Number(c.req.query("hours") ?? 24) || 24, 1), 720);
  const rows = loadSince(hours);
  const servers = db
    .prepare("SELECT * FROM hetzner_servers ORDER BY name")
    .all() as unknown as ServerRow[];

  // server → metric → points, in the order the query returned them (by ts).
  const byServer = new Map<number, Map<string, { ts: string; value: number }[]>>();
  for (const r of rows) {
    const metrics = byServer.get(r.serverId) ?? new Map();
    byServer.set(r.serverId, metrics);
    const points = metrics.get(r.metric) ?? [];
    metrics.set(r.metric, points);
    points.push({ ts: r.ts, value: r.value });
  }

  const series = (id: number, metric: string) =>
    byServer.get(id)?.get(metric) ?? [];

  /** Cores, where the fleet listing knows them. Below 1 is treated as unknown
   *  rather than as a divisor that would multiply the reading. */
  const coresOf = new Map<number, number | null>(
    servers.map((s) => [s.id, s.cores && s.cores >= 1 ? s.cores : null]),
  );

  const out = servers.map((s) => {
    const cores = coresOf.get(s.id) ?? null;
    const cpu = series(s.id, "cpu").map((p) => ({
      ts: p.ts,
      value: cores ? p.value / cores : p.value,
    }));
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      plan: s.plan,
      location: s.location,
      cores,
      /** False when cores were unknown: the CPU figures on this row are
       *  Hetzner's raw per-core sum and can exceed 100. */
      cpuScaled: cores !== null,
      monthlyEur: (s.monthly_eur ?? 0) + (s.ipv4_monthly_eur ?? 0),
      // The only per-server series sent whole: it is the one a card draws.
      // The rest travel as three numbers each, which is all any card asks of
      // them and a tenth of the bytes.
      cpu: { ...statRounded(cpu.map((p) => p.value)), points: cpu.map((p) => ({ ts: p.ts, value: Number(p.value.toFixed(2)) })) },
      netIn: statRounded(series(s.id, "net.in").map((p) => p.value), 0),
      netOut: statRounded(series(s.id, "net.out").map((p) => p.value), 0),
      diskRead: statRounded(series(s.id, "disk.read").map((p) => p.value), 0),
      diskWrite: statRounded(series(s.id, "disk.write").map((p) => p.value), 0),
      /** Samples behind those figures. Zero is a real answer: a box added ten
       *  minutes ago has a cost and a plan and no history at all. */
      samples: cpu.length,
    };
  });

  return c.json({
    hours,
    servers: out,
    fleet: {
      // Normalised first, for the same reason: a mean of "60% of two cores"
      // and "60% of four" is a real fleet figure; a mean of the raw sums is a
      // number in no unit.
      cpu: combine(
        rows.map((r) =>
          r.metric === "cpu"
            ? { ...r, value: r.value / (coresOf.get(r.serverId) || 1) }
            : r,
        ),
        "cpu",
        "mean",
      ),
      netIn: combine(rows, "net.in", "sum"),
      netOut: combine(rows, "net.out", "sum"),
      diskWrite: combine(rows, "disk.write", "sum"),
    },
    /** When the fleet itself was last listed — not when it was last sampled. */
    seenAt: servers[0]?.seen_at ?? null,
    /** The newest sample in the window, which is what a "collected 8m ago"
     *  line on a load card is actually reporting. */
    sampledAt: rows.length ? rows[rows.length - 1]!.ts : null,
  });
});

function statRounded(values: number[], dp = 1) {
  const s = stat(values);
  return { now: round(s.now, dp), mean: round(s.mean, dp), peak: round(s.peak, dp) };
}

/** One line for the whole fleet: the boxes reporting at each moment, meaned
 *  or summed depending on whether the unit survives addition. */
function combine(
  rows: { serverId: number; metric: string; ts: string; value: number }[],
  metric: string,
  how: "mean" | "sum",
): { ts: string; value: number }[] {
  const acc = new Map<string, [number, number]>();
  for (const r of rows) {
    if (r.metric !== metric) continue;
    const cur = acc.get(r.ts);
    if (cur) {
      cur[0] += r.value;
      cur[1] += 1;
    } else acc.set(r.ts, [r.value, 1]);
  }
  return [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ts, [sum, n]]) => ({
      ts,
      value: Number((how === "mean" ? sum / n : sum).toFixed(2)),
    }));
}

/* -------------------------------------------------------------- volumes */

hetznerRoutes.get("/volumes", (c) => {
  const volumes = db
    .prepare("SELECT * FROM hetzner_volumes ORDER BY name")
    .all() as unknown as (VolumeRow & { seen_at: string })[];
  // A volume names the server it is attached to, not its id — "the 40GB disk
  // on ue-api" is the sentence anybody actually wants.
  const names = new Map(
    (db.prepare("SELECT id, name FROM hetzner_servers").all() as unknown as {
      id: number;
      name: string | null;
    }[]).map((r) => [r.id, r.name]),
  );

  return c.json({
    volumes: volumes.map((v) => ({
      id: v.id,
      accountId: v.account_id,
      accountLabel: v.token_label,
      name: v.name,
      sizeGb: v.size_gb,
      location: v.location,
      serverId: v.server_id,
      attachedTo: v.server_id === null ? null : (names.get(v.server_id) ?? null),
      monthlyEur: v.monthly_eur,
    })),
    seenAt: volumes[0]?.seen_at ?? null,
  });
});
