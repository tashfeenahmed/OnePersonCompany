/**
 * SERVER SNAPSHOTS — what a box was doing at the moment it mattered.
 *
 * THE TABLE NEXT DOOR IS A TREND AND THIS IS AN INSTANT. `fleet_samples` is a
 * dozen numbers per box every thirty minutes: load, memory, disk, kept for a
 * month and read as a line on a chart. It is the right shape for "was it
 * swapping last night" and it is useless for the question that actually gets
 * asked at three in the morning — WHAT was eating the CPU, WHAT was listening
 * on that port, what did the log say just before it stopped. Sampling those on
 * a schedule is not an option: sixty processes per box per half hour is a
 * million rows a month to answer a question asked twice a year. So this is
 * taken ON DEMAND, or when something already went wrong, and kept whole.
 *
 * IT REUSES THE FLEET PLUGIN AND ADDS NO CREDENTIAL. `ssh()`, `parseSsh()`,
 * `writeKeyFile()` and `sshProblem()` are imported from ops/fleet.ts rather
 * than reimplemented — a second copy of key handling would be a second 0600
 * file, a second set of ssh options and a second place for a private key to be
 * written wrongly. A snapshot is therefore available for exactly the boxes the
 * owner already connected, under exactly the account they connected them with.
 *
 * THE SCRIPT EMITS DELIMITED TEXT, NOT JSON, and that is the one place this
 * file departs from the probe next door. The probe assembles JSON in awk
 * because every field it collects is a number or a short token. A snapshot is
 * fifty lines of a system journal, a `ps` line with an entire java command line
 * in it, and container names people chose — text that is full of quotes,
 * backslashes and control characters, escaped by hand in a shell, at three in
 * the morning, on a box nobody can debug from here. One malformed byte would
 * lose the whole document to a JSON parse error. Sections separated by a marker
 * cannot fail that way: the worst case is a section that reads oddly, and the
 * other seven are still there.
 *
 * A CAPTURE THAT FAILED IS STILL A SNAPSHOT. "The box would not answer at
 * 03:12" is precisely the fact somebody is looking for later, so a refused ssh
 * writes a row with `ok = 0` and the reason on it rather than nothing at all.
 *
 * NOTHING HERE TAKES A COMMAND, and that is the same line ops/fleet.ts draws in
 * its own header: the script below is fixed, in this file, and no route, skill
 * or action can add to it. An agent that could name the command would have a
 * root shell on every box in the list.
 */
import { db, now } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { registerRetention } from "../../shared/retention.ts";
import { parseSsh, sshLabel, ssh, sshProblem, writeKeyFile, type SshTarget } from "../ops/fleet.ts";

/* -------------------------------------------------------------- the script */

/**
 * ONE POSIX sh SCRIPT, printing SECTIONS.
 *
 * String.raw for the probe's reason: awk and shell escapes would be eaten by a
 * template literal. It contains no backtick and no `$`-brace, both of which
 * JavaScript would read before sh ever saw them.
 *
 * LINUX IS THE TARGET AND macOS IS A FALLBACK, exactly as the fleet probe has
 * it, because that is where the servers are and because "add this laptop" has
 * to work well enough to see the shape of the page. Every section names the
 * tool that answered it, so a reader is never left guessing whether an empty
 * list means "nothing is listening" or "there is no `ss` on this box".
 */
export const SNAPSHOT_SCRIPT = String.raw`
LC_ALL=C
export LC_ALL
PATH=$PATH:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin
export PATH

s() { printf '\n===OPC %s===\n' "$1"; }

s META
printf 'hostname=%s\n' "$(hostname 2>/dev/null || uname -n 2>/dev/null)"
printf 'kernel=%s\n' "$(uname -sr 2>/dev/null)"
printf 'date=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
UP=
if [ -r /proc/uptime ]; then UP=$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null); fi
if [ -z "$UP" ]; then
  BSEC=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\).*/\1/p')
  if [ -n "$BSEC" ]; then UP=$(( $(date +%s) - BSEC )); fi
fi
printf 'uptime_s=%s\n' "$UP"
printf 'loadavg=%s\n' "$(cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null)"

# ONE ps, SORTED TWICE. Two calls would be two different instants, and "the
# process using the memory" would not be the one in the CPU list a second
# earlier. -e is Linux's "every process"; where it produced nothing the BSD
# spelling is tried, which is what makes this readable on a Mac.
PSOUT=$(ps -eo pcpu,pmem,rss,etime,user,args 2>/dev/null | awk 'NR>1 && NF>=6')
if [ -z "$PSOUT" ]; then
  PSOUT=$(ps -Ao pcpu,pmem,rss,etime,user,args 2>/dev/null | awk 'NR>1 && NF>=6')
fi

s PSCPU
printf '%s\n' "$PSOUT" | sort -rn -k1 | head -15

s PSMEM
printf '%s\n' "$PSOUT" | sort -rn -k2 | head -15

s PORTS
if command -v ss >/dev/null 2>&1; then
  printf '#tool=ss\n'
  ss -lntup 2>/dev/null | head -60
elif command -v netstat >/dev/null 2>&1; then
  printf '#tool=netstat\n'
  netstat -an 2>/dev/null | grep -i listen | head -60
elif command -v lsof >/dev/null 2>&1; then
  printf '#tool=lsof\n'
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | head -60
else
  printf '#tool=none\n'
fi

s CONNS
CN=
if command -v ss >/dev/null 2>&1; then
  CN=$(ss -tn state established 2>/dev/null | awk 'NR>1' | wc -l | tr -d ' ')
fi
if [ -z "$CN" ] && command -v netstat >/dev/null 2>&1; then
  CN=$(netstat -an 2>/dev/null | grep -c ESTABLISHED | tr -d ' ')
fi
printf 'established=%s\n' "$CN"

s DISK
df -Pk 2>/dev/null | head -40

s LOG
if command -v journalctl >/dev/null 2>&1 && journalctl -n 1 --no-pager >/dev/null 2>&1; then
  printf '#source=journalctl\n'
  journalctl -n 50 --no-pager 2>/dev/null
elif [ -r /var/log/syslog ]; then
  printf '#source=/var/log/syslog\n'
  tail -n 50 /var/log/syslog 2>/dev/null
elif [ -r /var/log/messages ]; then
  printf '#source=/var/log/messages\n'
  tail -n 50 /var/log/messages 2>/dev/null
else
  printf '#source=none\n'
fi

s DOCKER
if command -v docker >/dev/null 2>&1; then
  printf '#installed=1\n'
  docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>&1 | head -50
else
  printf '#installed=0\n'
fi

s END
`;

/* -------------------------------------------------------------- the reading */

export type Proc = {
  cpu: number | null;
  mem: number | null;
  rssKb: number | null;
  elapsed: string | null;
  user: string | null;
  command: string;
};

export type SnapshotDoc = {
  host: string;
  target: string | null;
  ts: string;
  reason: string;
  ok: boolean;
  error: string | null;
  tookMs: number;
  meta: {
    hostname: string | null;
    kernel: string | null;
    boxTimeUtc: string | null;
    uptimeS: number | null;
    loadavg: string | null;
  };
  processes: { byCpu: Proc[]; byMem: Proc[]; note: string };
  ports: { tool: string | null; lines: string[]; note: string };
  connections: { established: number | null; note: string };
  disks: { lines: string[]; note: string };
  logs: { source: string | null; lines: string[]; note: string };
  docker: { installed: boolean | null; lines: string[]; note: string };
};

/** The sections out of the script's output, by name. A section the script did
 *  not reach is simply absent, which every reader below treats as "not
 *  measured" rather than as empty. */
function sections(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of stdout.split("\n")) {
    const m = /^===OPC ([A-Z]+)===$/.exec(raw.trim());
    if (m) {
      current = m[1]!;
      out.set(current, []);
      continue;
    }
    if (!current) continue;
    out.get(current)!.push(raw);
  }
  return out;
}

const kv = (lines: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const l of lines) {
    const at = l.indexOf("=");
    if (at < 1) continue;
    out[l.slice(0, at).trim()] = l.slice(at + 1).trim();
  }
  return out;
};

const numOrNull = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `pcpu pmem rss etime user args…` — the six fixed columns and then the whole
 *  command line, which may contain anything at all including spaces. */
function readProcs(lines: string[]): Proc[] {
  const out: Proc[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    const parts = l.split(/\s+/);
    if (parts.length < 6) continue;
    out.push({
      cpu: numOrNull(parts[0]),
      mem: numOrNull(parts[1]),
      rssKb: numOrNull(parts[2]),
      elapsed: parts[3] ?? null,
      user: parts[4] ?? null,
      command: parts.slice(5).join(" ").slice(0, 400),
    });
  }
  return out;
}

const clean = (lines: string[]): string[] =>
  lines.map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim().length > 0);

/** The marker line a section may lead with (`#tool=ss`), and the rest. */
function marker(lines: string[], key: string): { value: string | null; rest: string[] } {
  const rest = [...lines];
  let value: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!.trim();
    if (!t) continue;
    if (t.startsWith(`#${key}=`)) {
      value = t.slice(key.length + 2) || null;
      rest.splice(i, 1);
    }
    break;
  }
  return { value, rest };
}

/** The script's output, read into the document. Never throws: a section that
 *  did not arrive becomes a null with a note, because the whole point of this
 *  document is to survive a box that was in a bad state when it was asked. */
export function readSnapshot(stdout: string): Omit<SnapshotDoc, "host" | "target" | "ts" | "reason" | "ok" | "error" | "tookMs"> {
  const s = sections(stdout);
  const meta = kv(s.get("META") ?? []);

  const ports = marker(s.get("PORTS") ?? [], "tool");
  const logs = marker(s.get("LOG") ?? [], "source");
  const docker = marker(s.get("DOCKER") ?? [], "installed");
  const conns = kv(s.get("CONNS") ?? []);

  return {
    meta: {
      hostname: meta.hostname || null,
      kernel: meta.kernel || null,
      boxTimeUtc: meta.date || null,
      uptimeS: numOrNull(meta.uptime_s),
      loadavg: meta.loadavg || null,
    },
    processes: {
      byCpu: readProcs(s.get("PSCPU") ?? []),
      byMem: readProcs(s.get("PSMEM") ?? []),
      note:
        "The top fifteen of ONE `ps`, sorted two ways — the same instant in both lists. " +
        "`cpu` is the process's share since it started, not a sample over the last second: " +
        "a long-lived daemon reads low even while it is busy right now.",
    },
    ports: {
      tool: ports.value === "none" ? null : ports.value,
      lines: clean(ports.rest).slice(0, 60),
      note:
        ports.value === "none"
          ? "Nothing on that box could list sockets — no ss, no netstat, no lsof. This is NOT an empty list of ports."
          : "Verbatim from the tool named, capped at 60 lines. A socket the ssh user cannot see is not in here.",
    },
    connections: {
      established: numOrNull(conns.established),
      note:
        conns.established === undefined || conns.established === ""
          ? "Not counted — no tool on that box could count sockets. It is not zero connections."
          : "TCP sockets in ESTABLISHED at that instant, this ssh session included.",
    },
    disks: {
      lines: clean(s.get("DISK") ?? []).slice(0, 40),
      note: "`df -Pk` verbatim, 1K blocks. Pseudo filesystems are NOT filtered here, unlike the fleet probe — a snapshot is a transcript.",
    },
    logs: {
      source: logs.value === "none" ? null : logs.value,
      lines: clean(logs.rest).slice(0, 50),
      note:
        logs.value === "none"
          ? "No log this ssh user could read — no journalctl it is allowed to run, no readable /var/log/syslog or /var/log/messages. Not an absence of log lines."
          : "The last 50 lines at the moment of capture.",
    },
    docker: {
      installed: docker.value === "1" ? true : docker.value === "0" ? false : null,
      lines: clean(docker.rest).slice(0, 50),
      note:
        docker.value === "0"
          ? "docker is not on that box's PATH for this user. That is not zero containers."
          : "`docker ps` as name|image|status|ports. A daemon that refused answers with its own error on the first line.",
    },
  };
}

/* --------------------------------------------------------------- the boxes */

export type Box = { accountId: number; label: string; target: SshTarget; key: string | null };

/**
 * Every fleet box this can snapshot, read out of the vault the way the fleet
 * collector reads it — same plugin, same fields, its own reader name so
 * `secret_access` says which feature touched the key.
 */
export function boxes(): { ready: Box[]; problems: string[] } {
  const { ready, broken } = accounts.credentialed("fleet", ["host"], "snapshot");
  const problems = broken.map((b) => `${b.account.label}: missing ${b.missing.join(", ")}.`);
  const out: Box[] = [];
  for (const { account, values } of ready) {
    const target = parseSsh(values.host ?? "");
    if (!target) {
      problems.push(`${account.label}: “${values.host}” is not an ssh target any more.`);
      continue;
    }
    out.push({
      accountId: account.id,
      label: account.label,
      target,
      key: (values.key ?? "").trim() || null,
    });
  }
  return { ready: out, problems };
}

export function boxByAccount(id: number): Box | null {
  return boxes().ready.find((b) => b.accountId === id) ?? null;
}

/** By account id, or by label, case-insensitively — because a person asks for
 *  "the Pi" and a route asks for 3. */
export function findBox(key: string): Box | null {
  const { ready } = boxes();
  const asId = Number(key);
  if (Number.isInteger(asId) && asId > 0) {
    const byId = ready.find((b) => b.accountId === asId);
    if (byId) return byId;
  }
  return ready.find((b) => b.label.toLowerCase() === key.trim().toLowerCase()) ?? null;
}

/* -------------------------------------------------------------- capturing */

export type SnapshotRow = {
  id: number;
  account_id: number;
  host: string;
  ts: string;
  reason: string;
  doc: string;
  size: number;
  ok: number;
};

/**
 * One snapshot of one box, written down whichever way it goes.
 *
 * Never throws. An ssh that was refused is a row with `ok = 0`, the ssh error
 * translated by fleet's own `sshProblem`, and every section null — because "the
 * box would not answer at 03:12" is the finding, and a route that 500'd instead
 * would lose it.
 */
/**
 * NINETY DAYS, AND THIS TABLE HAD NO WINDOW AT ALL UNTIL NOW.
 *
 * Every row here is a WHOLE JSON DOCUMENT — the packages, the listening ports,
 * the users, the units — one per incident and one per time anybody pressed the
 * button. It is by a distance the heaviest table on the box per row, and it
 * was the one nothing anywhere deleted from, because there was no single place
 * that listed what gets pruned and so nobody noticed it was missing.
 *
 * Ninety days is chosen for what the document is FOR. A snapshot answers "what
 * did this box look like when it broke", and that question is asked in the
 * days and weeks after the break; a quarter of them is a generous margin on
 * "compare this against the last time it happened". Past that the document
 * describes a machine that has since been patched, upgraded and rebooted, so
 * it is no longer evidence about the machine in front of you — while still
 * being a full inventory of it, which is not a thing to keep for ever on a box
 * that also holds the credentials.
 */
registerRetention({
  table: "security_snapshots",
  column: "ts",
  days: 90,
  source: "area",
  note:
    "A whole inventory document per incident. A quarter covers “has this happened before”; older than that " +
    "it describes a machine that has since changed, and it is a full description of the box to keep lying around.",
});

export async function takeSnapshot(box: Box, reason: string): Promise<{ id: number; doc: SnapshotDoc }> {
  const ts = now();
  const keyFile = box.key ? writeKeyFile("fleet", box.accountId, box.key) : null;
  const ran = await ssh(box.target, keyFile, SNAPSHOT_SCRIPT);

  const failed = ran.code !== 0 || !ran.stdout.includes("===OPC META===");
  const error = failed
    ? ran.stdout.includes("===OPC META===")
      ? `The box answered but the capture did not finish (ssh exited ${ran.code ?? "without a status"}).`
      : sshProblem(ran, keyFile !== null)
    : null;

  const read = readSnapshot(ran.stdout);
  const doc: SnapshotDoc = {
    host: box.label,
    target: sshLabel(box.target),
    ts,
    reason,
    ok: !failed,
    error,
    tookMs: ran.ms,
    ...read,
  };

  const json = JSON.stringify(doc);
  const res = db
    .prepare(
      `INSERT INTO security_snapshots (account_id, host, ts, reason, doc, size, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(box.accountId, box.label, ts, reason, json, json.length, failed ? 0 : 1);

  return { id: Number(res.lastInsertRowid), doc };
}

/* ------------------------------------------------------------------ reads */

/** The list, without the documents. A snapshot is a hundred kilobytes and a
 *  list of thirty of them is a table of dates — the document is one request
 *  away at `/api/snapshots/:id`. */
export function snapshotList(opts: { accountId?: number | null; limit?: number }): {
  id: number;
  accountId: number;
  host: string;
  ts: string;
  reason: string;
  size: number;
  ok: boolean;
}[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = (
    opts.accountId
      ? db
          .prepare(
            "SELECT id, account_id, host, ts, reason, size, ok FROM security_snapshots WHERE account_id = ? ORDER BY ts DESC, id DESC LIMIT ?",
          )
          .all(opts.accountId, limit)
      : db
          .prepare(
            "SELECT id, account_id, host, ts, reason, size, ok FROM security_snapshots ORDER BY ts DESC, id DESC LIMIT ?",
          )
          .all(limit)
  ) as { id: number; account_id: number; host: string; ts: string; reason: string; size: number; ok: number }[];

  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    host: r.host,
    ts: r.ts,
    reason: r.reason,
    size: r.size,
    ok: r.ok === 1,
  }));
}

export function snapshotRow(id: number): SnapshotRow | undefined {
  return db.prepare("SELECT * FROM security_snapshots WHERE id = ?").get(id) as SnapshotRow | undefined;
}

export function lastSnapshotAt(accountId: number): string | null {
  const row = db
    .prepare("SELECT ts FROM security_snapshots WHERE account_id = ? ORDER BY ts DESC LIMIT 1")
    .get(accountId) as { ts: string } | undefined;
  return row?.ts ?? null;
}

/* ------------------------------------------------------- the uptime trigger */

/** No more than one automatic snapshot of a box an hour. A box that is having a
 *  bad night would otherwise be ssh'd into every five minutes by the thing
 *  investigating why it is having a bad night. */
export const AUTO_COOLDOWN_MS = 3_600_000;
/** How often the trigger looks. Under the collector's own half hour, so a
 *  failure is investigated within minutes of being recorded rather than at the
 *  next collection. */
const TRIGGER_EVERY_MS = 300_000;
/** How far back a failure counts as fresh. Wider than the tick so a tick that
 *  was late (a laptop that slept) still sees the failure it missed. */
const FRESH_MS = 1_800_000;

export type NewFailure = { host: string; ts: string; status: number | null; error: string | null };

/**
 * Uptime checks that FAILED and whose previous check for the same host had
 * SUCCEEDED — the transitions, not the ongoing outage.
 *
 * A "failure" defined as any failing check would fire once per collection for
 * as long as a site was down; what is wanted is the moment it went, because
 * that is the moment whose process list is worth having. The hourly cooldown is
 * the second guard, not the first.
 *
 * It reads the ops area's table directly rather than over its route, which is
 * the one place this area reaches into another's data. The alternative — an
 * HTTP call to /api/uptime from a timer — would be this process asking itself a
 * question in order to look at two columns.
 */
export function newFailures(sinceMs = FRESH_MS): NewFailure[] {
  const since = new Date(Date.now() - sinceMs).toISOString();
  let rows: { host: string; ts: string; ok: number; status: number | null; error: string | null }[];
  try {
    rows = db
      .prepare(
        `SELECT host, ts, ok, status, error FROM uptime_checks
          WHERE ts >= ? ORDER BY host, ts`,
      )
      .all(since) as typeof rows;
  } catch {
    /* The ops area's table is not there — this box has no uptime integration
       built. Nothing to trigger on, and not an error. */
    return [];
  }

  const out: NewFailure[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const prev = seen.get(r.host);
    if (r.ok === 0 && prev === 1) out.push({ host: r.host, ts: r.ts, status: r.status, error: r.error });
    seen.set(r.host, r.ok);
  }
  return out;
}

/**
 * Which boxes a failing HOST is about.
 *
 * THE JOIN IS THE OWNER'S OWN LINKS AND NOTHING CLEVERER. `venture_links` holds
 * "this uptime host belongs to Acme" and "this fleet box belongs to
 * Acme", both written by the owner or suggested on the venture map. A host
 * and a box that share a venture are related; anything else — matching
 * hostnames, resolving DNS and comparing addresses — would be this file
 * guessing at an architecture it cannot see, and guessing wrongly means ssh'ing
 * into somebody's server because an unrelated site went down.
 *
 * A failing host linked to no box produces no snapshot, and the trigger says
 * so in the log rather than snapshotting everything.
 */
export function boxesForHost(host: string): number[] {
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT f.entity AS entity
           FROM venture_links u
           JOIN venture_links f
             ON f.venture_id = u.venture_id AND f.plugin = 'fleet'
          WHERE u.plugin = 'uptime' AND u.entity = ?`,
      )
      .all(host) as { entity: string }[];
    return rows.map((r) => Number(r.entity)).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

let triggerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The trigger, armed at boot.
 *
 * It arms nothing on a box with no fleet accounts and no uptime list: the pass
 * finds no failures, or finds failures linked to no box, and does nothing. Like
 * every other `onStart` on this seam it must not throw — a background pass that
 * took the process down would be a dashboard that will not start because
 * somebody's website is having a bad morning.
 */
export function startSnapshotTrigger() {
  if (triggerTimer) return;
  const pass = () => {
    void (async () => {
      try {
        const failures = newFailures();
        if (!failures.length) return;
        for (const f of failures) {
          const ids = boxesForHost(f.host);
          if (!ids.length) {
            console.log(
              `[snapshots] ${f.host} went down at ${f.ts} and is linked to no fleet box — nothing to capture. ` +
                `Link the host and the box to the same venture to change that.`,
            );
            continue;
          }
          for (const id of ids) {
            const last = lastSnapshotAt(id);
            if (last && Date.now() - Date.parse(last) < AUTO_COOLDOWN_MS) continue;
            const box = boxByAccount(id);
            if (!box) continue;
            const reason =
              `uptime: ${f.host} ${f.status === null ? `did not answer (${f.error ?? "no response"})` : `answered ${f.status}`}` +
              ` at ${f.ts}`;
            const { id: snapId, doc } = await takeSnapshot(box, reason);
            console.log(
              `[snapshots] ${box.label} captured as #${snapId} — ${doc.ok ? "ok" : `failed: ${doc.error}`}`,
            );
          }
        }
      } catch (err) {
        console.error("[snapshots] trigger pass failed:", err);
      }
    })();
  };
  triggerTimer = setInterval(pass, TRIGGER_EVERY_MS);
  triggerTimer.unref?.();
  /* Not on boot. Every `running` uptime check from before a restart is history
     by now, and a pass at start-up would ssh into a box because of a failure
     the owner already dealt with yesterday. The first pass is one tick away. */
}
