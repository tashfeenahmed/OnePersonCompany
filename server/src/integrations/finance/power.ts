/**
 * WHAT THE MACHINE UNDER THE DESK COSTS TO RUN — the line that stops local
 * inference looking free.
 *
 * A model call to OpenAI arrives with a price on it. The same call to a model
 * on the owner's own GPU arrives with nothing at all, so a dashboard that adds
 * up provider spend and calls it "model cost" is systematically wrong in the
 * direction of "run it locally". This priced the difference: watts × hours ×
 * tariff, with every one of those three saying where it came from.
 *
 * THE WATTS ARE ALWAYS TYPED IN AND NEVER MEASURED, and there is no default.
 * ssh can ask nvidia-smi what a GPU is drawing; it cannot ask what the whole
 * machine is drawing at the wall, which is what an electricity bill charges
 * for. So a machine has no power line until somebody types an idle and a busy
 * figure for it, and `estimated` is true on every line as a result — even the
 * ones whose HOURS are measured. The two are different claims and the line
 * carries both: `confidence` is about the hours, and the note is about the
 * watts.
 *
 * THE HOURS COME FROM THE WORKSTATION COLLECTOR'S OWN SAMPLES. Every ~30
 * minutes `workstation_state` records whether the machine answered and what
 * nvidia-smi said; that is a state series, and a span between two samples is
 * awake time if the earlier one was reachable and busy time if its GPU was
 * over the threshold. No new logging was added to the security area for this:
 * the transitions are already recoverable from the samples, and a second
 * writer to the same fact is a second thing that can disagree.
 *
 * WHAT IT REFUSES TO DO. A machine with a profile and no samples at all gets a
 * line with a NULL amount and the reason, not a zero and not an idle-watt
 * guess — unless the profile says `always_on`, in which case a flat idle month
 * is the honest model and `confidence` says `estimated`. Coverage is reported
 * on every metered line: "up 41h of the 62h we were watching, in a 720h month"
 * is a very different fact from "up 41h in a month", and only the first one is
 * true on the first day.
 */
import { db, configValue, now } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { PLUGIN, archiveMissing, bump, tally, upsertSeed, type SeedCounts } from "./expenses.ts";
import { currencyCode, daysInMonth, money } from "./money.ts";

export const WORKSTATION_PLUGIN = "workstation";

/** The longest a single sample may stand for. The collector runs every ~30
 *  minutes; two hours covers a slow cycle and a restart without letting one
 *  sample taken before a week-long shutdown claim the whole week. */
export const MAX_SPAN_S = 7_200;

/** GPU utilisation at or above this counts the span as BUSY. A setting,
 *  because "busy" for a 3090 doing inference and for a laptop compositing a
 *  window are different numbers. */
export const DEFAULT_BUSY_PERCENT = 20;

export type ProfileRow = {
  machine_id: string;
  label: string | null;
  idle_watts: number;
  busy_watts: number;
  rate_per_kwh: number | null;
  currency: string;
  timezone: string | null;
  always_on: number;
  updated_at: string;
};

export function profiles(): ProfileRow[] {
  return db.prepare("SELECT * FROM finance_power_profiles ORDER BY machine_id").all() as unknown as ProfileRow[];
}

export function profile(machineId: string): ProfileRow | undefined {
  return db.prepare("SELECT * FROM finance_power_profiles WHERE machine_id = ?").get(machineId) as ProfileRow | undefined;
}

export function saveProfile(p: {
  machineId: string;
  label?: string | null;
  idleWatts: number;
  busyWatts: number;
  ratePerKwh?: number | null;
  currency?: string;
  timezone?: string | null;
  alwaysOn?: boolean;
}): ProfileRow {
  db.prepare(
    `INSERT INTO finance_power_profiles
       (machine_id, label, idle_watts, busy_watts, rate_per_kwh, currency, timezone, always_on, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(machine_id) DO UPDATE SET
       label = excluded.label, idle_watts = excluded.idle_watts, busy_watts = excluded.busy_watts,
       rate_per_kwh = excluded.rate_per_kwh, currency = excluded.currency,
       timezone = excluded.timezone, always_on = excluded.always_on, updated_at = excluded.updated_at`,
  ).run(
    p.machineId, p.label ?? null, p.idleWatts, p.busyWatts, p.ratePerKwh ?? null,
    currencyCode(p.currency ?? "EUR"), p.timezone ?? null, p.alwaysOn ? 1 : 0, now(),
  );
  return profile(p.machineId)!;
}

export function deleteProfile(machineId: string): boolean {
  return Number(db.prepare("DELETE FROM finance_power_profiles WHERE machine_id = ?").run(machineId).changes) > 0;
}

/* ------------------------------------------------------------ the tariff */

/** The plugin-wide electricity price, used by any profile that carries none of
 *  its own. Null when nobody has typed one — which makes every power line
 *  unpriced rather than free. */
export function tariff(): { perKwh: number | null; currency: string } {
  const raw = (configValue(PLUGIN, "kwh_rate") ?? "").trim();
  const n = raw ? Number(raw) : NaN;
  return {
    perKwh: Number.isFinite(n) && n > 0 ? n : null,
    currency: currencyCode((configValue(PLUGIN, "kwh_currency") ?? "EUR").trim() || "EUR"),
  };
}

export function busyPercent(): number {
  const raw = (configValue(PLUGIN, "busy_gpu_percent") ?? "").trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_BUSY_PERCENT;
}

/* -------------------------------------------------------- observed hours */

export type Observed = {
  /** Seconds the machine answered over the window. */
  awakeS: number;
  /** Seconds of that with a GPU at or above the busy threshold. */
  busyS: number;
  /** Seconds the window was actually WATCHED. The denominator that stops a
   *  part-month reading as a whole one. */
  coveredS: number;
  samples: number;
  source: "workstation-samples" | "leases";
};

type Sample = { ts: string; reachable: number; gpu: string | null };

/** The largest GPU utilisation in one sample's JSON, or null when nvidia-smi
 *  did not answer — which is not zero, and is why a null sample can never
 *  count as busy. */
function gpuUtilisation(json: string | null): number | null {
  if (!json) return null;
  try {
    const gpus = JSON.parse(json) as { utilisationPercent: number | null }[];
    const values = gpus.map((g) => g.utilisationPercent).filter((v): v is number => typeof v === "number");
    return values.length ? Math.max(...values) : null;
  } catch {
    return null;
  }
}

/**
 * Walk one machine's samples over a month and add up the spans.
 *
 * A SPAN BELONGS TO THE SAMPLE THAT OPENED IT. Sample at 10:00 says reachable,
 * sample at 10:30 says not: the machine was up for that half hour and went
 * down somewhere in it. Attributing the span forward instead would credit a
 * sleeping machine with the time it was awake.
 */
export function observe(machineId: string, month: string, nowIso = now()): Observed | null {
  const start = `${month}-01T00:00:00.000Z`;
  const endMs = Math.min(
    Date.parse(`${month}-${String(daysInMonth(month)).padStart(2, "0")}T23:59:59.999Z`),
    Date.parse(nowIso),
  );
  if (endMs < Date.parse(start)) return null;

  const rows = db
    .prepare(
      "SELECT ts, reachable, gpu FROM workstation_state WHERE account_id = ? AND ts >= ? AND ts <= ? ORDER BY ts",
    )
    .all(Number(machineId), start, new Date(endMs).toISOString()) as unknown as Sample[];
  if (!rows.length) return null;

  const threshold = busyPercent();
  let awakeS = 0;
  let busyS = 0;
  let coveredS = 0;
  for (let i = 0; i < rows.length; i++) {
    const here = rows[i]!;
    const nextMs = i + 1 < rows.length ? Date.parse(rows[i + 1]!.ts) : endMs;
    const span = Math.max(0, Math.min(MAX_SPAN_S, (nextMs - Date.parse(here.ts)) / 1000));
    coveredS += span;
    if (here.reachable !== 1) continue;
    awakeS += span;
    const util = gpuUtilisation(here.gpu);
    if (util !== null && util >= threshold) busyS += span;
  }
  return { awakeS, busyS, coveredS, samples: rows.length, source: "workstation-samples" };
}

/**
 * THE FALLBACK, and it is written defensively on purpose.
 *
 * Another area may land a `leases` table — job leases, one row per piece of
 * work with a start and an end — and where it exists it is a better source for
 * "how long was this machine busy" than a 30-minute GPU sample. Nothing here
 * depends on that area existing: the table is looked for in `sqlite_master`,
 * its columns are checked before they are read, and any surprise is caught and
 * reported as "no lease evidence" rather than breaking the power line.
 */
export function observeFromLeases(machineId: string, month: string, nowIso = now()): Observed | null {
  /* TWO NAMES, BECAUSE THE TABLE IS SOMEBODY ELSE'S. The deploy area landed
     `job_leases`; a future one may call it `leases`. Both are looked for and
     neither is required — this returns null and the power line falls back to
     the workstation samples, which is the ordinary path. */
  const table = (["job_leases", "leases"] as const).find((name) =>
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
  if (!table) return null;
  try {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
    const startCol = ["acquired_at", "started_at", "start_at", "created_at"].find((c) => columns.has(c));
    const endCol = ["released_at", "ended_at", "end_at", "expires_at"].find((c) => columns.has(c));
    const hostCol = ["resource", "machine_id", "machine", "host", "node"].find((c) => columns.has(c));
    if (!startCol || !endCol || !hostCol) return null;
    /* The deploy area names a desk machine `workstation:<accountId>`; a bare id
       is accepted too, so a table that keys on the id alone still joins. */
    const rows = db
      .prepare(
        `SELECT ${startCol} AS a, ${endCol} AS b FROM ${table}
         WHERE (${hostCol} = ? OR ${hostCol} = ?) AND ${startCol} LIKE ?`,
      )
      .all(`${WORKSTATION_PLUGIN}:${machineId}`, machineId, `${month}%`) as { a: string | null; b: string | null }[];
    if (!rows.length) return null;
    const endMs = Math.min(
      Date.parse(`${month}-${String(daysInMonth(month)).padStart(2, "0")}T23:59:59.999Z`),
      Date.parse(nowIso),
    );
    let busyS = 0;
    for (const r of rows) {
      if (!r.a) continue;
      const from = Date.parse(r.a);
      const to = r.b ? Date.parse(r.b) : endMs;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
      busyS += (to - from) / 1000;
    }
    if (busyS <= 0) return null;
    /* Leases say when work RAN, not when the machine was up. Awake time is at
       least the busy time and nothing here can say it was more, so the two are
       reported equal and the note says the idle hours are invisible. */
    return { awakeS: busyS, busyS, coveredS: busyS, samples: rows.length, source: "leases" };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- the lines */

export type PowerLine = {
  machineId: string;
  label: string;
  /** The monthly cost, or null when it could not be established. Never zero
   *  standing in for "unknown". */
  amount: number | null;
  currency: string;
  kwh: number | null;
  watts: { idle: number; busy: number };
  perKwh: number | null;
  /** `metered` = the hours were observed. `estimated` = they were modelled
   *  from an always-on assumption. Null when there is no line to price. */
  confidence: "metered" | "estimated" | null;
  /** ALWAYS true. The wattage is typed in, whatever the hours are. */
  wattsEstimated: true;
  hours: { awake: number; busy: number; covered: number; inMonth: number } | null;
  samples: number;
  source: string;
  note: string;
};

const hrs = (s: number) => Number((s / 3600).toFixed(2));

/**
 * One machine's electricity for one month.
 *
 * TWO BANDS, because being on and being busy are hundreds of watts apart:
 * every awake second draws idle watts and the busy fraction draws the
 * DIFFERENCE on top. Charging all the uptime at the busy figure would treble
 * the line; charging it all at idle would miss the only cost the dashboard's
 * own inference creates.
 */
export function powerLine(p: ProfileRow, month: string, nowIso = now()): PowerLine {
  const t = tariff();
  const perKwh = p.rate_per_kwh ?? t.perKwh;
  const currency = currencyCode(p.rate_per_kwh !== null ? p.currency : t.currency);
  const label = p.label ?? `Machine ${p.machine_id}`;
  const monthHours = daysInMonth(month) * 24;
  const base = {
    machineId: p.machine_id,
    label,
    currency,
    watts: { idle: p.idle_watts, busy: p.busy_watts },
    perKwh,
    wattsEstimated: true as const,
  };

  const observed = observe(p.machine_id, month, nowIso) ?? observeFromLeases(p.machine_id, month, nowIso);

  if (!observed && p.always_on !== 1)
    return {
      ...base,
      amount: null,
      kwh: null,
      confidence: null,
      hours: null,
      samples: 0,
      source: "none",
      note:
        `No workstation samples for ${month} and no job leases, so how long this machine was on is not known. ` +
        `Unpriced rather than nought — connect it as a workstation so the collector records its state, or tick ` +
        `“always on” if it never sleeps.`,
    };

  const awakeS = observed ? observed.awakeS : monthHours * 3600;
  const busyS = observed ? observed.busyS : 0;
  const kwh = (awakeS * p.idle_watts + busyS * (p.busy_watts - p.idle_watts)) / 3_600_000;
  const coverage = observed ? observed.coveredS / (monthHours * 3600) : 1;

  const note = observed
    ? `Up ${hrs(awakeS)}h of the ${hrs(observed.coveredS)}h actually sampled, in a ${monthHours}h month ` +
      `(${(coverage * 100).toFixed(0)}% of it watched); ${hrs(busyS)}h of that with a GPU at or above ` +
      `${busyPercent()}%. Hours from ${observed.source === "leases" ? "job leases — idle hours are invisible to them" : "the workstation collector's own state samples"}. ` +
      `The wattage is typed in, not measured: nothing here can read a wall socket.` +
      (coverage < 0.9 ? ` This is a PART-MONTH figure and will grow as the month is sampled.` : "")
    : `Always-on: ${p.idle_watts}W for the whole ${monthHours}h month. No uptime was observed and none is claimed — ` +
      `this is a model, and both the watts and the hours are assumptions.`;

  return {
    ...base,
    amount: perKwh === null ? null : money(kwh * perKwh),
    kwh: Number(kwh.toFixed(3)),
    confidence: observed ? "metered" : "estimated",
    hours: { awake: hrs(awakeS), busy: hrs(busyS), covered: hrs(observed?.coveredS ?? monthHours * 3600), inMonth: monthHours },
    samples: observed?.samples ?? 0,
    source: observed?.source ?? "always-on",
    note:
      perKwh === null
        ? `${note} No price per kWh has been set, so there is no money on this line. Set one on the Finance integration's page.`
        : note,
  };
}

/** Every profiled machine, priced for a month. */
export function powerLines(month: string, nowIso = now()): PowerLine[] {
  return profiles().map((p) => powerLine(p, month, nowIso));
}

/**
 * The machines a profile could be written for: every workstation account,
 * whether or not it has one yet. The client draws the "add a profile" row off
 * this, so the owner never has to know an account id.
 */
export function machinesAvailable(): { machineId: string; label: string; hasProfile: boolean }[] {
  const have = new Set(profiles().map((p) => p.machine_id));
  return accounts.list(WORKSTATION_PLUGIN).map((a) => ({
    machineId: String(a.id),
    label: a.label,
    hasProfile: have.has(String(a.id)),
  }));
}

/* --------------------------------------------------- into the ledger */

/**
 * One monthly electricity row per profiled machine, refreshed on every
 * collection.
 *
 * IT IS A LEDGER ROW LIKE ANY OTHER — shared by default, allocatable, visible
 * beside the servers and the domains — because that is the point: a €14 month
 * of electricity should sit in the same table as a €7 server, not on a page of
 * its own where nobody adds it up. `confidence` travels with it so the row can
 * never be read as a quoted price.
 *
 * IT IS PRICED FOR THE MONTH THAT IS ENDING, not the one running. The current
 * month is a part-month by definition; a ledger row is a run rate, and the
 * best available run rate is the last complete month's measurement. The month
 * used is named in the note.
 */
export function seedPower(nowIso = now()): SeedCounts {
  const t = tally();
  const list = profiles();
  const keep = new Set<string>();
  /* The previous calendar month, in UTC — the same clock every sample uses. */
  const d = new Date(nowIso);
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

  for (const p of list) {
    const ref = `machine:${p.machine_id}`;
    keep.add(ref);
    const line = powerLine(p, prev, nowIso);
    bump(t, upsertSeed("power", {
      sourceRef: ref,
      label: `Electricity — ${line.label}`,
      category: "other",
      amount: line.amount,
      currency: line.currency,
      period: "monthly",
      renewalOn: null,
      ventureId: null,
      confidence: line.confidence,
      notes: `${prev}: ${line.note}`,
    }));
  }
  t.archived = archiveMissing("power", keep);
  return t;
}
