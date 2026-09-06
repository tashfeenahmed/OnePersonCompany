/**
 * THE WORKSTATION — one account is one machine on the owner's own desk, and
 * the only integration here that can turn something ON.
 *
 * WHY IT IS NOT A SECOND FLEET ACCOUNT. `fleet` measures boxes that are always
 * up: it probes on a schedule and a box that did not answer is an incident. A
 * workstation is expected to be off. Nine mornings in ten the honest answer to
 * "how is the desktop" is "asleep", and a plugin that reported that as a
 * failure would train the owner to ignore the one morning it means something.
 * So this keeps a thinner history — reachable or not, uptime, the GPU — and it
 * has the two things fleet deliberately does not: a way to wake the machine and
 * a way to put it back.
 *
 * WAKE IS A UDP BROADCAST AND NOTHING ELSE. A magic packet is six 0xFF bytes
 * and the MAC sixteen times, sent to the broadcast address of the LAN. It needs
 * no credential, no agent on the target and no port open — the network card
 * answers it while the machine is off. It also cannot be confirmed: nothing
 * acknowledges a magic packet, so `POST /wake` reports that the packet was SENT
 * and never that the machine woke. The page has to ask again, and it says so.
 *
 * SLEEP AND SHUTDOWN ARE COMMANDS THE OWNER TYPED, and that is the same line
 * ops/fleet.ts draws about counters. There is no per-OS lookup table in here
 * that quietly runs `sudo shutdown -h now` on a machine somebody connected out
 * of curiosity. The settings hint names the documented command for each OS, the
 * owner pastes the one that is right for their machine and their sudoers file,
 * and until they do, the route refuses and says which command it would have
 * wanted. A route that could compose a privileged command from a dropdown is a
 * route one bug away from halting the wrong machine.
 *
 * THE SSH HALF IS FLEET'S. `parseSsh`, `writeKeyFile`, `ssh` and `sshProblem`
 * are imported rather than copied — one implementation of "where does the
 * private key go and at what mode", for the reason that file gives.
 */
import { createSocket } from "node:dgram";
import { db, configValue, finishRun, now, record, startRun, syncPlugin } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { pruneOne, registerRetention, retentionFor } from "../../shared/retention.ts";
import { parseSsh, sshLabel, ssh, sshProblem, writeKeyFile, type SshTarget } from "../ops/fleet.ts";

export const PLUGIN = "workstation";

/* ------------------------------------------------------------------- MAC */

const MAC_RE = /^([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})$/i;

/** The six bytes, or null. Accepts colons, dashes or nothing between them,
 *  because all three are printed by real tools and none of them is wrong. */
export function parseMac(raw: string | null | undefined): number[] | null {
  const m = MAC_RE.exec((raw ?? "").trim());
  if (!m) return null;
  return m.slice(1, 7).map((h) => Number.parseInt(h, 16));
}

export function macLabel(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(":");
}

/** A dotted IPv4, which is all a broadcast address can usefully be. */
export function validBroadcast(raw: string): boolean {
  const parts = raw.trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/** The limited broadcast. It reaches the local segment and is never routed,
 *  which is what makes it a safe default: a packet that cannot leave the LAN
 *  cannot wake somebody else's machine. A subnet broadcast (192.168.1.255) is
 *  the setting for a network where the limited one is filtered. */
export const DEFAULT_BROADCAST = "255.255.255.255";
/** Ports 9 (discard) and 7 (echo) are both conventional for this; 9 is what
 *  every consumer NIC listens on and what every tool sends to. */
const WOL_PORT = 9;

/**
 * The magic packet: 6 bytes of 0xFF then the MAC, sixteen times.
 *
 * Sent THREE times, a few milliseconds apart. UDP to a broadcast address has no
 * retransmission and no acknowledgement, and a single packet lost to a busy
 * switch is a wake that silently did not happen. Three is what every wake-on-LAN
 * tool does and it costs 306 bytes.
 */
export function magicPacket(mac: number[]): Buffer {
  const buf = Buffer.alloc(102);
  buf.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) buf.set(mac, 6 + i * 6);
  return buf;
}

export function sendMagicPacket(mac: number[], broadcast: string): Promise<{ sent: number; error: string | null }> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const packet = magicPacket(mac);
    let sent = 0;
    let settled = false;
    const done = (error: string | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve({ sent, error });
    };

    socket.on("error", (err) => done(err.message));
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        done(err instanceof Error ? err.message : String(err));
        return;
      }
      let n = 0;
      const fire = () => {
        socket.send(packet, WOL_PORT, broadcast, (err) => {
          if (err) {
            done(err.message);
            return;
          }
          sent += 1;
          n += 1;
          if (n >= 3) {
            done(null);
            return;
          }
          setTimeout(fire, 20).unref?.();
        });
      };
      fire();
    });

    /* A bind that never completes — a machine with no usable interface — must
       not hold the request for ever. */
    setTimeout(() => done("The UDP socket did not open in time."), 5_000).unref?.();
  });
}

/* -------------------------------------------------------------- the account */

export type Machine = {
  accountId: number;
  label: string;
  target: SshTarget;
  key: string | null;
  mac: number[] | null;
  macRaw: string | null;
  broadcast: string;
};

/** Every connected workstation, read out of the vault. `mac` and `broadcast`
 *  are optional fields on the credential rather than settings, because they
 *  belong to ONE machine and settings here are per plugin. */
export function machines(): { ready: Machine[]; problems: string[] } {
  const { ready, broken } = accounts.credentialed(PLUGIN, ["host"], "workstation");
  const problems = broken.map((b) => `${b.account.label}: missing ${b.missing.join(", ")}.`);
  const out: Machine[] = [];
  for (const { account, values } of ready) {
    const target = parseSsh(values.host ?? "");
    if (!target) {
      problems.push(`${account.label}: “${values.host}” is not an ssh target any more.`);
      continue;
    }
    const macRaw = (values.mac ?? "").trim() || null;
    const broadcast = (values.broadcast ?? "").trim() || DEFAULT_BROADCAST;
    out.push({
      accountId: account.id,
      label: account.label,
      target,
      key: (values.key ?? "").trim() || null,
      mac: macRaw ? parseMac(macRaw) : null,
      macRaw,
      broadcast,
    });
  }
  return { ready: out, problems };
}

export function findMachine(key: string): Machine | null {
  const { ready } = machines();
  const asId = Number(key);
  if (Number.isInteger(asId) && asId > 0) {
    const byId = ready.find((m) => m.accountId === asId);
    if (byId) return byId;
  }
  return ready.find((m) => m.label.toLowerCase() === key.trim().toLowerCase()) ?? null;
}

/* ------------------------------------------------------------------- state */

/**
 * ONE sh SCRIPT: is it awake, for how long, and what is the GPU doing.
 *
 * `nvidia-smi` IS ASKED FOR BY NAME AND ITS ABSENCE IS A REASON, never a zero.
 * A machine with an AMD card, a Mac, or an NVIDIA machine whose driver is not
 * loaded all answer "no nvidia-smi", and each of those is a different thing
 * from "the GPU is idle". The query is the documented CSV form so the columns
 * cannot move under us.
 */
export const STATE_SCRIPT = String.raw`
LC_ALL=C
export LC_ALL
PATH=$PATH:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin
export PATH

printf 'os=%s\n' "$(uname -s 2>/dev/null)"
printf 'hostname=%s\n' "$(hostname 2>/dev/null || uname -n 2>/dev/null)"
UP=
if [ -r /proc/uptime ]; then UP=$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null); fi
if [ -z "$UP" ]; then
  BSEC=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\).*/\1/p')
  if [ -n "$BSEC" ]; then UP=$(( $(date +%s) - BSEC )); fi
fi
printf 'uptime_s=%s\n' "$UP"

if command -v nvidia-smi >/dev/null 2>&1; then
  OUT=$(nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>&1)
  RC=$?
  if [ "$RC" = 0 ]; then
    printf 'gpu_ok=1\n'
    printf '%s\n' "$OUT" | sed -e 's/^/gpu=/'
  else
    printf 'gpu_ok=0\n'
    printf 'gpu_note=%s\n' "$(printf '%s' "$OUT" | tr -d '[:cntrl:]' | cut -c1-200)"
  fi
else
  printf 'gpu_ok=0\n'
  printf 'gpu_note=nvidia-smi is not on this machine PATH for this user.\n'
fi
`;

export type Gpu = {
  name: string;
  temperatureC: number | null;
  utilisationPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
};

export type MachineState = {
  id: number;
  label: string;
  target: string;
  mac: string | null;
  broadcast: string;
  reachable: boolean;
  hostname: string | null;
  os: string | null;
  uptimeS: number | null;
  gpus: Gpu[] | null;
  gpuNote: string | null;
  error: string | null;
  /**
   * WHY IT DID NOT ANSWER, TO THE ONLY RESOLUTION THAT MATTERS — and this
   * field exists because "unreachable" was being read as "asleep", which is
   * how this app came to claim it may power off machines it never woke.
   *
   * `silence` is a TCP SYN nothing replied to: a timeout, no route, a host
   * that is down. That is what a sleeping machine looks like from here, and it
   * is the ONLY shape that supports a wake-ownership claim.
   *
   * `refused-or-broken` is everything else — a rotated key, a changed host
   * key, a name that does not resolve, an sshd that answered with RST. Every
   * one of those is compatible with a machine that is wide awake and busy, so
   * nothing may be inferred about its power state from them.
   *
   * `null` when the machine answered.
   */
  unreachable: "silence" | "refused-or-broken" | null;
  ms: number;
  checkedAt: string;
};

/** A SYN that nothing answered — the only failure shape a sleeping machine
 *  produces. Matched on ssh's own words rather than on an exit code, because
 *  ssh exits 255 for all of them. */
function unreachableKind(stderr: string): "silence" | "refused-or-broken" {
  return /connection timed out|operation timed out|timed out after|no route to host|host is down|network is unreachable/i.test(
    stderr,
  )
    ? "silence"
    : "refused-or-broken";
}

/**
 * WHAT STATE THE MACHINE WAS IN, for the wake-ownership record.
 *
 * THE THREE ANSWERS ARE NOT A SCALE. `awake` and `asleep` are observations;
 * `unknown` is the absence of one, and it is what an ssh failure that is not
 * silence honestly is. `integrations/deploy/leases.ts` treats anything but
 * `asleep` as "not ours", so an `unknown` machine is one this app will never
 * offer to power off — which is the safe direction and the point.
 */
export function foundState(s: MachineState): "asleep" | "awake" | "unknown" {
  if (s.reachable) return "awake";
  return s.unreachable === "silence" ? "asleep" : "unknown";
}

const numOrNull = (v: string | undefined | null): number | null => {
  if (v === undefined || v === null || v.trim() === "" || v.trim() === "[N/A]") return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
};

/** One machine, asked. Never throws: an unreachable machine is a state with
 *  `reachable: false` and the ssh error translated, because "asleep" is the
 *  expected answer here rather than an incident. */
export async function readState(m: Machine): Promise<MachineState> {
  const checkedAt = now();
  const keyFile = m.key ? writeKeyFile(PLUGIN, m.accountId, m.key) : null;
  const ran = await ssh(m.target, keyFile, STATE_SCRIPT);

  const base = {
    id: m.accountId,
    label: m.label,
    target: sshLabel(m.target),
    mac: m.mac ? macLabel(m.mac) : null,
    broadcast: m.broadcast,
    ms: ran.ms,
    checkedAt,
  };

  if (ran.code !== 0 || !ran.stdout.includes("os=")) {
    return {
      ...base,
      reachable: false,
      hostname: null,
      os: null,
      uptimeS: null,
      gpus: null,
      gpuNote: "The machine did not answer, so nothing could be asked about a GPU.",
      error: sshProblem(ran, keyFile !== null),
      unreachable: unreachableKind(ran.stderr),
    };
  }

  const fields: Record<string, string> = {};
  const gpuLines: string[] = [];
  for (const line of ran.stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key === "gpu") gpuLines.push(value);
    else fields[key] = value;
  }

  const gpus =
    fields.gpu_ok === "1"
      ? gpuLines
          .map((l) => l.split(",").map((p) => p.trim()))
          .filter((p) => p.length >= 5 && p[0])
          .map((p) => ({
            name: p[0]!,
            temperatureC: numOrNull(p[1]),
            utilisationPercent: numOrNull(p[2]),
            memoryUsedMb: numOrNull(p[3]),
            memoryTotalMb: numOrNull(p[4]),
          }))
      : null;

  return {
    ...base,
    reachable: true,
    hostname: fields.hostname || null,
    os: fields.os || null,
    uptimeS: numOrNull(fields.uptime_s),
    gpus,
    gpuNote:
      gpus === null
        ? fields.gpu_note || "nvidia-smi did not answer. This is not a machine with no GPU — it is a GPU nothing here could read."
        : null,
    error: null,
    unreachable: null,
  };
}

/* ------------------------------------------------------------------ verify */

/**
 * Verify, for the credential registry.
 *
 * A SLEEPING MACHINE PASSES, IF A MAC WAS GIVEN, and that is the whole
 * difference between this and fleet's verify next door. Fleet refuses a box it
 * cannot reach because an unreachable server is a broken credential. Here the
 * expected state is off: refusing would mean the owner has to get up, wake the
 * desktop by hand and come back, to connect the thing whose entire purpose is
 * to save them that walk. So an ssh that fails with a MAC on file is accepted
 * with a note; an ssh that fails with NO MAC is refused, because at that point
 * nothing about the account can ever work.
 */
export async function verify(values: Record<string, string>): Promise<string | null> {
  const raw = (values.host ?? "").trim();
  if (!raw) return "Type the machine as user@host — for example user@workstation.example.test, or test@192.0.2.40:2222.";
  const t = parseSsh(raw);
  if (!t) return `“${raw}” is not an ssh target. It is user@host, optionally with :port — no scheme, no path.`;

  const macRaw = (values.mac ?? "").trim();
  if (macRaw && !parseMac(macRaw))
    return `“${macRaw}” is not a MAC address. Six hex pairs — aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff or aabbccddeeff. It is the WIRED adapter's address: wake-on-LAN over wifi does not work on most machines.`;

  const broadcast = (values.broadcast ?? "").trim();
  if (broadcast && !validBroadcast(broadcast))
    return `“${broadcast}” is not a broadcast address. A dotted IPv4 such as 192.168.1.255, or leave it empty for ${DEFAULT_BROADCAST}.`;

  const key = (values.key ?? "").trim();
  let keyFile: string | null = null;
  if (key) {
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key))
      return "That is not a private key. Paste the PRIVATE half — the file without .pub — whole, including its BEGIN and END lines.";
    if (/ENCRYPTED/.test(key))
      return "That key has a passphrase. This runs with no terminal to type one into, so it needs a key with no passphrase.";
    const { writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { keysDir } = await import("../ops/fleet.ts");
    keyFile = join(keysDir(), `${PLUGIN}-verify-${process.pid}-${Date.now()}.pem`);
    writeFileSync(keyFile, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    try {
      const ran = await ssh(t, keyFile, "echo ok\n");
      if (ran.code === 0 && ran.stdout.includes("ok")) return null;
      if (macRaw) return null;
      return `${sshProblem(ran, true)} — and with no MAC address on this account there is nothing here that could wake it either. Add the MAC and it will be accepted asleep.`;
    } finally {
      rmSync(keyFile, { force: true });
    }
  }

  const ran = await ssh(t, null, "echo ok\n");
  if (ran.code === 0 && ran.stdout.includes("ok")) return null;
  if (macRaw) return null;
  return `${sshProblem(ran, false)} — and with no MAC address on this account there is nothing here that could wake it either. Add the MAC and it will be accepted asleep.`;
}

/* ------------------------------------------------------------- the lease key */

/**
 * WHAT THIS MACHINE IS CALLED IN THE LEASE REGISTRY.
 *
 * The account id rather than the label, because a label is something the owner
 * renames and a lease taken under the old name would then be a lease on a
 * machine nothing can find. One function, here, so the power routes and any
 * job that wants to claim the desk machine spell it the same way — the same
 * argument the config keys above make about a string that is a foreign key.
 */
export function leaseResource(m: Machine | { accountId: number }): string {
  return `workstation:${m.accountId}`;
}

/* ------------------------------------------------------- the power commands */

/**
 * The documented commands, per operating system, as a HINT and never as
 * something this file will run on its own.
 *
 * These are what goes in the settings field's help and in the error a power
 * route returns when nothing has been set. They are quoted because every one of
 * them depends on a sudoers rule or a policy this app cannot see: `systemctl
 * suspend` works without a password on a desktop with a logged-in session and
 * fails on a headless box; macOS's `pmset sleepnow` needs no privilege at all
 * and `shutdown -h now` needs root.
 */
export const DOCUMENTED: Record<string, { sleep: string; shutdown: string }> = {
  Linux: { sleep: "systemctl suspend", shutdown: "sudo systemctl poweroff" },
  Darwin: { sleep: "pmset sleepnow", shutdown: "sudo shutdown -h now" },
  FreeBSD: { sleep: "acpiconf -s3", shutdown: "sudo shutdown -p now" },
};

export const CONFIG_KEYS = { sleep: "sleep", shutdown: "shutdown" } as const;

/** What the owner typed for this action, or null. Empty means "nothing may
 *  run", which is the default state and the safe one. */
export function powerCommand(action: "sleep" | "shutdown"): string | null {
  return (configValue(PLUGIN, CONFIG_KEYS[action]) ?? "").trim() || null;
}

/** The sentence a power route answers with when nothing has been typed. It
 *  names the documented command for the OS the machine last reported, so the
 *  owner has something to paste rather than something to research. */
export function noCommandYet(action: "sleep" | "shutdown", os: string | null): string {
  const doc = os && DOCUMENTED[os] ? DOCUMENTED[os]![action] : null;
  const all = Object.entries(DOCUMENTED)
    .map(([k, v]) => `${k}: “${v[action]}”`)
    .join(", ");
  return (
    `No ${action} command has been set, so nothing was run. ` +
    `Type one on the Workstation integration's page` +
    (doc
      ? `. On ${os} the documented command is “${doc}”.`
      : `. The documented ones are ${all}.`) +
    ` Check it works in your own terminal first: whether it needs sudo depends on that machine's own policy, ` +
    `and nothing here can know that.`
  );
}

export type PowerResult = {
  ok: boolean;
  action: "sleep" | "shutdown";
  command: string;
  exit: number | null;
  output: string;
  error: string | null;
  note: string;
};

/**
 * Run the owner's power command over ssh.
 *
 * A NON-ZERO EXIT IS NOT NECESSARILY A FAILURE and the note says so. A machine
 * told to sleep frequently drops the ssh connection before the shell can report
 * a status, which arrives here as a killed channel — indistinguishable from a
 * command that did not exist. So the result reports what happened literally and
 * refuses to translate it into a verdict the wire cannot support: ask again in
 * ten seconds, that is the test.
 */
export async function power(m: Machine, action: "sleep" | "shutdown", command: string): Promise<PowerResult> {
  const keyFile = m.key ? writeKeyFile(PLUGIN, m.accountId, m.key) : null;
  const ran = await ssh(m.target, keyFile, `${command}\n`);
  const output = [ran.stdout.trim(), ran.stderr.trim()].filter(Boolean).join("\n").slice(0, 800);
  return {
    ok: ran.code === 0,
    action,
    command,
    exit: ran.code,
    output,
    error: ran.code === 0 ? null : sshProblem(ran, keyFile !== null),
    note:
      `The command was sent. Whether the machine actually ${action === "sleep" ? "slept" : "shut down"} is not ` +
      `something ssh can report — a machine going down usually kills the connection before the shell answers, which ` +
      `looks exactly like a command that failed. Ask for the state again in ten seconds; that is the test.`,
  };
}

/* --------------------------------------------------------------- collector */

export function writeState(s: MachineState) {
  db.prepare(
    `INSERT OR REPLACE INTO workstation_state (account_id, ts, reachable, uptime_s, gpu, gpu_note, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.id,
    s.checkedAt,
    s.reachable ? 1 : 0,
    s.uptimeS,
    s.gpus ? JSON.stringify(s.gpus) : null,
    s.gpuNote,
    s.error,
  );
}

export type StateRow = {
  account_id: number;
  ts: string;
  reachable: number;
  uptime_s: number | null;
  gpu: string | null;
  gpu_note: string | null;
  error: string | null;
};

export function statesSince(hours: number): StateRow[] {
  const since = new Date(Date.now() - Math.min(Math.max(hours, 1), 720) * 3_600_000).toISOString();
  return db
    .prepare("SELECT * FROM workstation_state WHERE ts >= ? ORDER BY ts")
    .all(since) as StateRow[];
}

/** Rows for accounts that no longer exist, dropped. The same reaping fleet does
 *  for its key files, and for the same reason: account deletion happens in a
 *  route this area does not own. */
export function forgetGoneMachines(): number {
  const live = new Set(accounts.list(PLUGIN).map((a) => a.id));
  const rows = db.prepare("SELECT DISTINCT account_id AS id FROM workstation_state").all() as { id: number }[];
  let gone = 0;
  for (const r of rows) {
    if (live.has(r.id)) continue;
    db.prepare("DELETE FROM workstation_state WHERE account_id = ?").run(r.id);
    gone += 1;
  }
  return gone;
}

/** Samples older than this are dropped by the collector. Thirty days answers
 *  "has it been off all week"; a year of it would answer nothing better. */
export const RETAIN_DAYS = 30;
registerRetention({
  table: "workstation_state",
  column: "ts",
  days: RETAIN_DAYS,
  source: "area",
  note: "Thirty days answers “has it been off all week”; a year of it would answer nothing better.",
});

export function pruneStates(): number {
  return pruneOne(retentionFor("workstation_state")!);
}

/* --------------------------------------------------------------- collecting */

export type WorkstationSummary = {
  ok: boolean;
  runId: number;
  machines: number;
  awake: number;
  pruned: number;
  forgotten: number;
  warnings: string[];
  error?: string | null;
  note?: string | null;
};

/**
 * Every workstation, asked once, one at a time.
 *
 * A MACHINE THAT IS ASLEEP IS A SUCCESSFUL COLLECTION, and this is the one
 * collector on this box where that is true. Fleet's marks an account failed
 * when a box will not answer, because a server that is off is an incident; a
 * desktop that is off at four in the afternoon is a desktop. So an unreachable
 * machine writes a row saying so, keeps its account connected, and the run
 * succeeds. The run FAILS only when there is no machine at all.
 *
 * `workstation.<id>.awake` goes into readings as 1 or 0 so the reachability
 * history is chartable the same way every other figure on this box is. It is
 * the only metric recorded: uptime is on the state row and a GPU temperature is
 * a fact about one instant of a machine that is usually off.
 */
export async function collectWorkstation(): Promise<WorkstationSummary> {
  const runId = startRun(PLUGIN);
  const forgotten = forgetGoneMachines();
  const { ready, problems } = machines();
  const warnings = [...problems];

  if (!ready.length && !problems.length) {
    const error = "No workstation is connected. Add one as user@host on the plugin page.";
    finishRun(runId, false, undefined, error);
    syncPlugin(PLUGIN, error);
    return { ok: false, runId, machines: 0, awake: 0, pruned: 0, forgotten, warnings, error };
  }

  let awake = 0;
  for (const m of ready) {
    const state = await readState(m);
    writeState(state);
    record(`workstation.${m.accountId}.awake`, state.reachable ? 1 : 0, { machine: m.label });
    if (state.reachable) {
      awake += 1;
      accounts.markOk(m.accountId);
    } else {
      /* NOT `markFailed`. A sleeping machine is not a broken credential, and
         marking it one would turn the plugin page red every night. The state
         row carries the reason and the page draws it. */
      warnings.push(`${m.label}: not reachable — ${state.error}`);
    }
  }

  const pruned = pruneStates();
  const note =
    `${awake}/${ready.length} awake` +
    (pruned ? `, ${pruned} row(s) aged out` : "") +
    (forgotten ? `, ${forgotten} removed machine(s) forgotten` : "");
  finishRun(runId, true, note, warnings.join("; ") || undefined);
  syncPlugin(PLUGIN, null);

  return { ok: true, runId, machines: ready.length, awake, pruned, forgotten, warnings, note };
}
