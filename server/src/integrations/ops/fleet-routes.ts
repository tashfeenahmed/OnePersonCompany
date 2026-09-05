/**
 * The fleet document — what each box IS, what it is doing, and the ONE total
 * that is honest across boxes.
 *
 * WHICH FIGURES ADD IS THE WHOLE ARGUMENT OF THIS FILE, and only one of the
 * three does. MEMORY ADDS: fifty gigabytes on one box and eight on another
 * really is fifty-eight gigabytes of RAM the owner is paying for.
 *
 * LOAD DOES NOT. A load average is already relative to a machine's cores — 4.0
 * on a sixteen-core box is idle and on a single-core Pi it is a fire — so
 * "fleet load" is a number in no unit, the same mistake /api/hetzner's header
 * refuses for CPU percentages. What is published instead is load PER CPU per
 * box, which is comparable, and a count of how many boxes are above 1.0.
 *
 * DISK DOES NOT EITHER, which is less obvious and worth the sentence.
 * Filesystems share pools: a Mac's `/` and `/System/Volumes/Data` each report
 * the same 359 GB free out of one APFS container, and a snapshot mount reports
 * its parent's usage over again. Adding them puts a terabyte and a half of
 * free space on a one-terabyte disk — the de-duplicated-figure rule wearing a
 * different hat. So there is no fleet disk total, and `fullestDisk` is the
 * figure the page is actually for.
 *
 * MEMORY USED IS TOTAL MINUS AVAILABLE. Linux's page cache is not memory
 * anybody is short of; "94% used" that is mostly cache is how a server
 * dashboard learns to cry wolf. The probe does the subtraction at the source
 * (see fleet.ts) and this file only draws it.
 *
 * DISK PERCENTAGE IS used / (used + avail) AND NOT used / size. That is what
 * `df` itself reports as Capacity, and on the two filesystems that matter here
 * it is the only sane reading: ext4 reserves 5% for root, and an APFS
 * container shares its free space between volumes, so a Mac's root volume
 * reports 17 GB used, 359 GB available and a 994 GB "size". used/size would
 * call that disk 2% full when df, Finder and every alert anybody would want
 * agree it is 62%.
 *
 * COUNTERS ARE THE OWNER'S OWN QUESTIONS and the values come from readings, so
 * they have real history. A counter with no reading is reported as having no
 * reading — never as zero. See fleet.ts's `parseCounters` for the format and
 * for why there is no route that takes a command.
 */
import { Hono } from "hono";
import { configValue, series } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import {
  counterMetric,
  hostRows,
  latestContainers,
  latestDisks,
  parseCounters,
  parseSsh,
  samplesSince,
  type SampleRow,
} from "./fleet.ts";

export const fleetRoutes = new Hono();

/** Where a meter turns amber and where it turns red. Published on the document
 *  rather than left to the client, so the agent and the page agree about what
 *  "nearly full" means. */
const WARN = 80;
const CRIT = 90;

function clamp(value: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, value));
}

function meter(used: number | null, free: number | null) {
  if (used === null || free === null) return null;
  const denom = used + free;
  if (denom <= 0) return null;
  const percent = Math.round((used / denom) * 1000) / 10;
  return {
    used,
    free,
    percent,
    level: percent >= CRIT ? "critical" : percent >= WARN ? "warn" : "ok",
  };
}

/**
 * Is this hostname something a venture could plausibly BE at?
 *
 * A public name, with a dot and a TLD. `localhost`, an IP and a Tailscale
 * short name are all perfectly good ssh targets and none of them is a website,
 * so they produce a null host and no auto-link suggestion rather than a
 * suggestion nobody can act on.
 */
export function publicHost(hostname: string): string | null {
  const h = hostname.toLowerCase();
  if (h === "localhost" || /^[0-9.]+$/.test(h) || /^\[/.test(h)) return null;
  if (/\.(local|internal|lan|home|arpa)$/.test(h)) return null;
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) ? h : null;
}

/** The ssh hostname of each account, from the collector's cache — never from
 *  the vault. Drawing a page must not decrypt a private key. */
function targets(): Map<number, string | null> {
  return new Map(hostRows().map((h) => [h.account_id, h.target]));
}

fleetRoutes.get("/", (c) => {
  const hours = clamp(Number(c.req.query("hours") ?? 24) || 24, 1, 720);
  const list = accounts.list("fleet");
  const hosts = new Map(hostRows().map((h) => [h.account_id, h]));
  const samples = samplesSince(hours);
  const disks = latestDisks();
  const containers = latestContainers();
  const counters = parseCounters(configValue("fleet", "counters"));

  const byAccount = new Map<number, SampleRow[]>();
  for (const s of samples) {
    const held = byAccount.get(s.account_id) ?? [];
    held.push(s);
    byAccount.set(s.account_id, held);
  }

  const boxes = list.map((account) => {
    const host = hosts.get(account.id) ?? null;
    const mine = byAccount.get(account.id) ?? [];
    const last = mine.at(-1) ?? null;
    const myDisks = disks.filter((d) => d.account_id === account.id);

    return {
      accountId: account.id,
      label: account.label,
      /** From the collector's cache of the vault. Null until the first
       *  collection — the credential exists, nothing has used it yet. */
      target: host?.target ?? null,
      hostname: host?.hostname ?? null,
      kernel: host?.kernel ?? null,
      seenAt: host?.seen_at ?? null,
      okAt: host?.ok_at ?? account.lastOkAt,
      /** The last thing that went wrong reaching this box. Null is not
       *  "healthy" on its own — check `okAt`. */
      error: host?.error ?? account.lastError,
      sample: last && {
        ts: last.ts,
        uptimeSeconds: last.uptime_s,
        cpus: last.cpus,
        load: { one: last.load1, five: last.load5, fifteen: last.load15 },
        /** The only load figure that means the same thing on every box. Null
         *  when the core count is unknown — an undivided load average put
         *  beside a divided one is the mistake this field exists to avoid. */
        loadPerCpu:
          last.load1 !== null && last.cpus
            ? Math.round((last.load1 / last.cpus) * 100) / 100
            : null,
        memory: meter(last.mem_used, last.mem_avail),
        memoryTotal: last.mem_total,
        swap:
          last.swap_total && last.swap_used !== null
            ? meter(last.swap_used, last.swap_total - last.swap_used)
            : null,
      },
      disks: myDisks.map((d) => ({
        mount: d.mount,
        size: d.size,
        used: d.used,
        avail: d.avail,
        meter: meter(d.used, d.avail),
      })),
      containers: containers
        .filter((ct) => ct.account_id === account.id)
        .map((ct) => ({ name: ct.name, image: ct.image, status: ct.status, since: ct.since })),
      /** Null means the probe never reached the box. 0 means docker is not
       *  installed there, which is different from "no containers running". */
      docker:
        host?.docker === null || host?.docker === undefined
          ? null
          : { installed: host.docker === 1, running: containers.filter((ct) => ct.account_id === account.id).length },
      counters: counters.map((counter) => {
        const history = series(counterMetric(account.id, counter.label), Math.ceil(hours / 24) || 1);
        const latest = history.at(-1) ?? null;
        return {
          label: counter.label,
          command: counter.command,
          latest: latest && { ts: latest.ts, value: latest.value },
          series: history.map((r) => ({ ts: r.ts, value: r.value })),
          /** Said out loud because a counter with no readings looks exactly
             like a counter reading zero on a chart that draws nothing. */
          note: history.length
            ? null
            : "No value yet on this box — the command has not run, or it failed or printed no number. It is not zero.",
        };
      }),
      samples: mine.map((s) => ({
        ts: s.ts,
        load1: s.load1,
        memUsed: s.mem_used,
        memTotal: s.mem_total,
        swapUsed: s.swap_used,
      })),
    };
  });

  const answering = boxes.filter((b) => b.sample);
  const memTotal = answering.reduce((n, b) => n + (b.sample?.memoryTotal ?? 0), 0);
  const memUsed = answering.reduce((n, b) => n + (b.sample?.memory?.used ?? 0), 0);

  return c.json({
    window: { hours, unit: "bytes for memory and disk, seconds for uptime" },
    thresholds: { warn: WARN, critical: CRIT, basis: "percent of used / (used + available)" },
    boxes,
    totals: {
      boxes: list.length,
      answering: answering.length,
      /** THIS ADDS. A byte of RAM on one box and a byte on another are two
       *  bytes of RAM the owner is paying for. */
      memoryBytes: answering.length ? { total: memTotal, used: memUsed } : null,
      /**
       * DISK DOES NOT ADD, and that is not a limitation of this code.
       * Filesystems share pools: a Mac's `/` and `/System/Volumes/Data` each
       * report the same 359 GB free out of one APFS container, an ext4
       * snapshot mount reports its parent's usage again, and adding them
       * would put a terabyte and a half of "free space" on a one-terabyte
       * disk. It is the de-duplicated-figure rule wearing a different hat.
       * What IS true is per mount, and `fullestDisk` is the figure the page
       * is actually for.
       */
      diskBytes: {
        combined: null,
        note: "Filesystems share pools, so their sizes are not addable — see fullestDisk and each box's own mounts.",
      },
      containers: containers.length,
      /** DELIBERATELY NOT A FLEET LOAD AVERAGE. Load is already relative to a
       *  box's cores, so adding or averaging it across boxes produces a number
       *  in no unit. What is comparable is how many boxes are working harder
       *  than they have cores for. */
      load: {
        combined: null,
        note: "Load averages are per machine and are never added or averaged across machines — 4.0 is idle on sixteen cores and a fire on one.",
        boxesOverOnePerCpu: answering.filter((b) => (b.sample?.loadPerCpu ?? 0) > 1).length,
      },
      /** The one figure a fleet page is actually for. */
      fullestDisk:
        boxes
          .flatMap((b) => b.disks.map((d) => ({ box: b.label, mount: d.mount, percent: d.meter?.percent ?? null })))
          .filter((d) => d.percent !== null)
          .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0] ?? null,
      seenAt: hostRows().map((h) => h.seen_at).sort().at(-1) ?? null,
    },
  });
});

/**
 * The counters on their own — the same numbers, cut by counter rather than by
 * box, which is how they are actually asked about ("is the queue draining
 * anywhere?").
 */
fleetRoutes.get("/counters", (c) => {
  const days = clamp(Number(c.req.query("days") ?? 7) || 7, 1, 30);
  const list = accounts.list("fleet");
  const counters = parseCounters(configValue("fleet", "counters"));

  return c.json({
    window: { days },
    format: "One line per counter: “label = shell command”. The same commands run on every box.",
    /** Said here because it is the rule an agent is most likely to try to talk
     *  itself out of. */
    rule: "Counter commands are typed by the owner in settings. There is no route and no action that runs an arbitrary command on a box.",
    counters: counters.map((counter) => ({
      label: counter.label,
      command: counter.command,
      boxes: list.map((account) => {
        const history = series(counterMetric(account.id, counter.label), days);
        const latest = history.at(-1) ?? null;
        return {
          accountId: account.id,
          label: account.label,
          latest: latest && { ts: latest.ts, value: latest.value },
          series: history.map((r) => ({ ts: r.ts, value: r.value })),
        };
      }),
    })),
    note: counters.length
      ? null
      : "No counters configured. They are the owner's own measurements — a line of “label = shell command” on the fleet plugin page.",
  });
});

/**
 * What a venture could be linked to here.
 *
 * The entity is the ACCOUNT ID rather than the hostname, because that is what
 * survives: a box gets renamed, moves address and keeps its account. The
 * hostname is offered separately as `host` so a venture whose own host is that
 * name can be suggested — and it is null for a box that is not on a public
 * name, which is most of them.
 */
fleetRoutes.get("/entities", (c) => {
  const t = targets();
  return c.json({
    entities: accounts.list("fleet").map((a) => {
      const parsed = t.get(a.id) ? parseSsh(t.get(a.id)!) : null;
      return {
        plugin: "fleet",
        entity: String(a.id),
        label: a.label,
        host: parsed ? publicHost(parsed.host) : null,
      };
    }),
  });
});
