/**
 * Hetzner Cloud.
 *
 * WHAT THE OWNER PASTES: one read-only API token, per ACCOUNT. A Hetzner token
 * is scoped to a SINGLE PROJECT, so an account with three projects is three
 * accounts here — each with its own label, its own connection state and its own
 * last error. That is the whole reason the plugin below this file holds a list.
 * Console → the project → Security → API tokens → Read.
 *
 * This used to be one entry holding a token per line. The tokens were real and
 * the bill was right, but nothing downstream could say WHICH project a server
 * belonged to or WHICH token had stopped answering, and the owner could not
 * name, replace or remove one of them without re-pasting all of them. The blob
 * is gone; the accounts it implied are what replaced it.
 *
 * WHAT IT READS, and nothing else:
 *   GET /v1/pricing                    the current rate card, per location
 *   GET /v1/servers?per_page=50&page=N the servers this project has
 *   GET /v1/volumes?per_page=50&page=N attached block storage
 *   GET /v1/servers/{id}/metrics       what each box has been doing
 *
 * All three are free, unmetered and read-only. A Read token cannot create,
 * resize or delete anything, so the confinement is Hetzner's rather than ours.
 *
 * PRICES ARE PER LOCATION AND THAT MATTERS. Hetzner quotes every plan at every
 * location and they are not equal. Matching the server's own location is the
 * difference between a right answer and a plausible one, so there is no
 * fallback to "the first price in the list" — a price from the wrong datacentre
 * is a made-up number, and this returns null instead.
 *
 * The primary IPv4 is billed separately from the plan, the same way Hetzner
 * invoices it, so it is a separate column rather than folded into the server
 * price. Everything here is net of VAT, in EUR, because that is what the API
 * returns; converting currencies is the caller's problem and not this file's.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";

export const HETZNER_API = "https://api.hetzner.cloud/v1";
const TIMEOUT_MS = 20_000;
const MAX_PAGES = 10;

export type HetznerServer = {
  id: number;
  /** The account this box was read through, and its label at that moment.
   *  A fleet page that cannot say which project a server is in is a fleet
   *  page that has quietly merged two bills. */
  accountId: number;
  accountLabel: string;
  name: string | null;
  ipv4: string | null;
  status: string | null;
  plan: string | null;
  specs: string | null;
  location: string | null;
  cores: number | null;
  memoryGb: number | null;
  diskGb: number | null;
  architecture: string | null;
  monthlyEur: number | null;
  ipv4MonthlyEur: number | null;
  createdAt: string | null;
};

export type HetznerVolume = {
  id: number;
  accountId: number;
  accountLabel: string;
  name: string | null;
  sizeGb: number | null;
  location: string | null;
  serverId: number | null;
  monthlyEur: number | null;
};

/**
 * WHAT HETZNER CAN AND CANNOT TELL YOU ABOUT A RUNNING BOX.
 *
 * The metrics endpoint is measured by the HYPERVISOR, not inside the guest, so
 * it knows exactly four things: how much CPU the box is burning, and how many
 * bytes a second are crossing its network cards and its disks. It does not
 * know how much memory is in use, and it does not know how full the filesystem
 * is — both of those live inside the operating system, and reading them needs
 * something running in there.
 *
 * That is a real limit and it is not papered over anywhere downstream: this
 * dashboard has CPU meters and no memory meter, because a memory meter here
 * would have to be invented.
 */
export type MetricPoint = { ts: string; value: number };

/** The five series kept, named for what they are rather than for Hetzner's
 *  interface-indexed keys. Bandwidth is bytes per second. */
export type MetricName = "cpu" | "net.in" | "net.out" | "disk.read" | "disk.write";

export const METRIC_NAMES: MetricName[] = [
  "cpu",
  "net.in",
  "net.out",
  "disk.read",
  "disk.write",
];

/** Hetzner indexes its series by device — network.0, network.1 — because a box
 *  can have more than one card. Two cards are two halves of one answer, so the
 *  indices are summed rather than one of them being picked. */
const SERIES_MAP: [RegExp, MetricName][] = [
  [/^cpu$/, "cpu"],
  [/^network\.\d+\.bandwidth\.in$/, "net.in"],
  [/^network\.\d+\.bandwidth\.out$/, "net.out"],
  [/^disk\.\d+\.bandwidth\.read$/, "disk.read"],
  [/^disk\.\d+\.bandwidth\.write$/, "disk.write"],
];

/**
 * The window pulled every run, and its grain.
 *
 * A full day each time, not "since the last run": the request costs the same
 * either way, the rows are keyed by their own timestamp so re-reading an hour
 * twice writes it once, and it means a collector started five minutes ago
 * draws a real 24-hour line instead of a dot. History accumulates day over day
 * on top of it.
 */
export const METRIC_HOURS = 24;
export const METRIC_STEP_SECONDS = 900;

export type ServerMetrics = {
  serverId: number;
  series: Partial<Record<MetricName, MetricPoint[]>>;
};

/**
 * How one account fared, whatever the others did.
 *
 * `ok` is false only when the account told us NOTHING — its server listing
 * threw. A missing price or an unreadable metrics endpoint is a gap in an
 * answer that arrived, and an account demoted to "failing" over a gap is an
 * account the owner will go and re-paste a perfectly good token into.
 */
export type AccountOutcome = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
  servers: number;
};

export type CollectResult = {
  servers: HetznerServer[];
  volumes: HetznerVolume[];
  /** One entry per server the metrics endpoint answered for. */
  metrics: ServerMetrics[];
  /** Non-fatal: one account failed, or one plan had no price at its location. */
  warnings: string[];
  /** One per account that had a token to try, in the order they were tried. */
  accounts: AccountOutcome[];
  accountsTried: number;
};

/* --------------------------------------------------------------- http */

async function hzGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${HETZNER_API}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Hetzner puts a machine-readable reason in the body; a bare status code
    // sends the owner to the docs for something the API already explained.
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ? ` — ${body.error.message}` : "";
    } catch {
      /* not JSON; the status is all there is */
    }
    throw new HetznerError(res.status, `HTTP ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

export class HetznerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HetznerError";
    this.status = status;
  }
}

/** Every page, up to a ceiling — an unbounded loop against someone else's
 *  pagination is a way to hang a collector forever. */
async function paged<T>(
  path: string,
  token: string,
  key: "servers" | "volumes",
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const doc = await hzGet<{
      [k: string]: unknown;
      meta?: { pagination?: { next_page?: number | null } };
    }>(`${path}?per_page=50&page=${page}`, token);
    out.push(...((doc[key] as T[] | undefined) ?? []));
    if (!doc.meta?.pagination?.next_page) break;
  }
  return out;
}

/* ------------------------------------------------------------- pricing */

type Price = { location?: string; price_monthly?: { net?: string } };

/** Net EUR/month at THIS location, or null. Never another location's price. */
function monthlyAt(prices: Price[] | undefined, location: string | null): number | null {
  if (!location) return null;
  for (const p of prices ?? []) {
    if (p.location === location) {
      const n = Number(p.price_monthly?.net);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/* ------------------------------------------------------------- metrics */

type RawMetrics = {
  metrics?: {
    step?: number;
    time_series?: Record<string, { values?: [number, string][] }>;
  };
};

/**
 * One box's last day, in the five series above.
 *
 * Values arrive as [unix seconds, "12.345678"] — a STRING, which is why every
 * one goes through Number() and a finite check rather than being trusted. A
 * NaN here would become a flat zero on a chart, which reads as "the box did
 * nothing" rather than "the reading did not parse".
 */
export async function serverMetrics(
  id: number,
  token: string,
  hours = METRIC_HOURS,
  step = METRIC_STEP_SECONDS,
): Promise<Partial<Record<MetricName, MetricPoint[]>>> {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  const doc = await hzGet<RawMetrics>(
    `servers/${id}/metrics?type=cpu,network,disk` +
      `&start=${start.toISOString()}&end=${end.toISOString()}&step=${step}`,
    token,
  );

  // Summed per timestamp, because two network cards are two halves of one
  // number: a Map per metric keyed by the second the reading is stamped with.
  const acc = new Map<MetricName, Map<number, number>>();

  for (const [key, series] of Object.entries(doc.metrics?.time_series ?? {})) {
    const name = SERIES_MAP.find(([re]) => re.test(key))?.[1];
    if (!name) continue;
    const bucket = acc.get(name) ?? new Map<number, number>();
    acc.set(name, bucket);
    for (const [at, raw] of series.values ?? []) {
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      bucket.set(at, (bucket.get(at) ?? 0) + v);
    }
  }

  const out: Partial<Record<MetricName, MetricPoint[]>> = {};
  for (const [name, bucket] of acc) {
    out[name] = [...bucket.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([at, value]) => ({ ts: new Date(at * 1000).toISOString(), value }));
  }
  return out;
}

/* ------------------------------------------------------------- tokens */

/**
 * The lines of a paste that look like tokens.
 *
 * Kept, though a token now lives one to an account, because the OLD format is
 * still a thing an owner will paste: three tokens in a column, out of the
 * notes file they have kept since before this had a UI. The add route uses it
 * to recognise that and say "these are three accounts" rather than sealing a
 * blob that would fail against Hetzner as one very long bearer token.
 */
export function parseTokens(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** The accounts with a usable token, in the order they were added. */
export function tokenAccounts(
  reader: string,
): { account: Account; token: string }[] {
  return accounts
    .credentialed("hetzner", ["token"], reader)
    .ready.map(({ account, values }) => ({ account, token: values.token! }));
}

/* ------------------------------------------------------------- verify */

/**
 * Is this token real, and what does it see?
 *
 * Called before a token is stored, so a typo is refused at the point it was
 * made rather than becoming a silent empty dashboard an hour later.
 */
export async function verify(
  token: string,
): Promise<{ ok: true; servers: number } | { ok: false; error: string }> {
  try {
    const doc = await hzGet<{ meta?: { pagination?: { total_entries?: number } } }>(
      "servers?per_page=1",
      token,
    );
    return { ok: true, servers: doc.meta?.pagination?.total_entries ?? 0 };
  } catch (err) {
    if (err instanceof HetznerError) {
      if (err.status === 401)
        return { ok: false, error: "Hetzner rejected that token (401)." };
      if (err.status === 403)
        return { ok: false, error: "That token exists but lacks read access (403)." };
      return { ok: false, error: err.message };
    }
    const name = err instanceof Error ? err.name : "Error";
    return {
      ok: false,
      error:
        name === "TimeoutError"
          ? "Hetzner did not answer within 20 seconds."
          : `Could not reach Hetzner (${name}).`,
    };
  }
}

/* ------------------------------------------------------------ collect */

type RawServer = {
  id?: number;
  name?: string;
  status?: string;
  created?: string;
  public_net?: { ipv4?: { ip?: string } | null };
  location?: { name?: string } | null;
  datacenter?: { location?: { name?: string } } | null;
  server_type?: {
    name?: string;
    cores?: number;
    memory?: number;
    disk?: number;
    architecture?: string;
    prices?: Price[];
  };
};

type RawVolume = {
  id?: number;
  name?: string;
  size?: number;
  server?: number | null;
  location?: { name?: string } | null;
};

/**
 * Every connected account, one after another.
 *
 * ONE ACCOUNT FAILING LOSES ONLY THAT ACCOUNT. The old code already had this
 * instinct — a token that would not list servers was skipped with a warning
 * rather than aborting the run — and it is the whole loop's rule now: an
 * account that throws anywhere in its own block is recorded as failing, and
 * the servers, volumes and samples every other account produced are returned
 * exactly as if it had not been there. The alternative is a dead token in one
 * project taking the other two projects' bill off the page, which is a
 * dashboard lying about the money.
 */
export async function collect(reader = "collect_hetzner"): Promise<CollectResult> {
  const pairs = tokenAccounts(reader);
  const servers: HetznerServer[] = [];
  const volumes: HetznerVolume[] = [];
  const metrics: ServerMetrics[] = [];
  const warnings: string[] = [];
  const outcomes: AccountOutcome[] = [];

  /*
    A HETZNER RESOURCE ID IS GLOBAL, so the same id arriving under two accounts
    means one project has been connected twice — a token pasted into a second
    account, most often while the owner was working out what these labels do.
    Counted twice it doubles the bill; dropped quietly it makes an account look
    empty for no stated reason. So it is counted ONCE, under the account that
    saw it first, and the duplicate is reported as a warning that names both.
  */
  const firstSeen = new Map<number, string>();
  const duplicates = new Map<string, number>();

  for (const { account, token } of pairs) {
    const label = account.label;

    let pricing: {
      primary_ips?: { type?: string; prices?: Price[] }[];
      // Volumes are priced one way for everywhere, so this is a bare
      // {net, gross} rather than the per-location list the plans use.
      volume?: { price_per_gb_month?: { net?: string } };
    } = {};
    try {
      pricing =
        (await hzGet<{ pricing?: typeof pricing }>("pricing", token)).pricing ?? {};
    } catch (err) {
      warnings.push(`${label}: pricing unreadable (${describe(err)})`);
    }

    const ipv4Prices = pricing.primary_ips?.find((p) => p.type === "ipv4")?.prices;
    const volumePerGb = pricing.volume?.price_per_gb_month;

    let raw: RawServer[];
    try {
      raw = await paged<RawServer>("servers", token, "servers");
    } catch (err) {
      // The one failure that means this account said nothing at all. It is the
      // account's own error, not the plugin's, so it lands on the account's
      // row and the loop carries on to the next project.
      const error = `${describe(err)} listing servers`;
      warnings.push(`${label}: ${error}`);
      outcomes.push({ id: account.id, label, ok: false, error, servers: 0 });
      continue;
    }

    for (const s of raw) {
      if (s.id === undefined) continue;
      const owner = firstSeen.get(s.id);
      if (owner !== undefined) {
        const key = `${label}\u0000${owner}`;
        duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
        continue;
      }
      firstSeen.set(s.id, label);
      // Hetzner moved this: servers now carry a top-level `location` and answer
      // `datacenter: null`. The old nesting stays as a fallback for regions
      // still on the previous shape.
      const location = s.location?.name ?? s.datacenter?.location?.name ?? null;
      const type = s.server_type ?? {};
      const monthly = monthlyAt(type.prices, location);
      if (monthly === null) {
        warnings.push(
          `${label}: no ${location ?? "?"} price for ${type.name ?? "?"} (${s.name ?? s.id})`,
        );
      }

      const ipv4 = s.public_net?.ipv4?.ip?.trim() || null;
      const cores = type.cores ?? null;
      const memory = type.memory ?? null;
      const disk = type.disk ?? null;
      const arch = type.architecture ?? null;

      servers.push({
        id: s.id,
        accountId: account.id,
        accountLabel: label,
        name: s.name ?? null,
        ipv4,
        status: s.status ?? null,
        plan: type.name?.toUpperCase() ?? null,
        specs:
          cores && memory && disk
            ? `${cores} vCPU · ${Number(memory)} GB · ${disk} GB${
                arch?.toLowerCase() === "arm" ? " · ARM" : ""
              }`
            : null,
        location,
        cores,
        memoryGb: memory,
        diskGb: disk,
        architecture: arch,
        monthlyEur: monthly,
        ipv4MonthlyEur: ipv4 ? monthlyAt(ipv4Prices, location) : null,
        createdAt: s.created ?? null,
      });
    }

    /*
      One request per box, sequentially. A fleet this size is seven calls that
      each take a moment, and firing them all at once at somebody else's rate
      limiter to save two seconds on a job that runs twice an hour is a poor
      trade. A box that will not answer costs its own line and nothing else —
      the fleet, the bill and the other boxes' lines all still arrive.
    */
    for (const s of servers) {
      if (s.accountId !== account.id) continue;
      try {
        const series = await serverMetrics(s.id, token);
        if (Object.keys(series).length) metrics.push({ serverId: s.id, series });
      } catch (err) {
        warnings.push(`${label}: no metrics for ${s.name ?? s.id} (${describe(err)})`);
      }
    }

    try {
      for (const v of await paged<RawVolume>("volumes", token, "volumes")) {
        if (v.id === undefined) continue;
        // Volume ids are global too, and share the servers' namespace problem
        // for the same reason: the same project, connected twice.
        if (volumes.some((x) => x.id === v.id)) continue;
        const location = v.location?.name ?? null;
        const perGb = Number(volumePerGb?.net);
        const size = v.size ?? null;
        volumes.push({
          id: v.id,
          accountId: account.id,
          accountLabel: label,
          name: v.name ?? null,
          sizeGb: size,
          location,
          serverId: v.server ?? null,
          monthlyEur:
            size !== null && Number.isFinite(perGb)
              ? Number((size * perGb).toFixed(4))
              : null,
        });
      }
    } catch (err) {
      warnings.push(`${label}: ${describe(err)} listing volumes`);
    }

    outcomes.push({
      id: account.id,
      label,
      ok: true,
      servers: servers.filter((s) => s.accountId === account.id).length,
    });
  }

  for (const [key, n] of duplicates) {
    const [label, owner] = key.split("\u0000");
    warnings.push(
      `${label}: ${n} server${n === 1 ? "" : "s"} already seen under “${owner}” — ` +
        `the same project is connected twice, and is counted once.`,
    );
  }

  return {
    servers,
    volumes,
    metrics,
    warnings,
    accounts: outcomes,
    accountsTried: pairs.length,
  };
}

function describe(err: unknown): string {
  if (err instanceof HetznerError) return err.message;
  return err instanceof Error ? err.name : "Error";
}

/** Net EUR/month for everything the account currently has. */
export function monthlyTotal(r: CollectResult): number {
  const s = r.servers.reduce(
    (n, x) => n + (x.monthlyEur ?? 0) + (x.ipv4MonthlyEur ?? 0),
    0,
  );
  const v = r.volumes.reduce((n, x) => n + (x.monthlyEur ?? 0), 0);
  return Number((s + v).toFixed(2));
}
