/**
 * THE BOXES, OVER SSH — the one integration here that asks a machine about
 * itself rather than asking a vendor about it.
 *
 * WHY IT EXISTS BESIDE HETZNER RATHER THAN INSIDE IT. Hetzner measures from
 * the HYPERVISOR: it can see CPU, network and disk throughput, and it says so
 * in its own route's header that it structurally cannot see memory or disk
 * capacity, because it is not inside the guest. This is inside the guest. It
 * is also the only thing here that answers for a box Hetzner never sold — a
 * Raspberry Pi on the owner's desk, a VPS at another provider, this laptop.
 *
 * ONE ACCOUNT IS ONE BOX, and the account's own label is the box's name. There
 * is no `label` field in the credential set for that reason: `POST
 * /api/plugins/fleet/accounts` already takes a label, and a second name stored
 * beside it in the vault would be a name that can disagree with the one on the
 * page.
 *
 * THE KEY IS OPTIONAL AND THAT IS THE INTERESTING CASE. With no key, ssh uses
 * whatever the owner's own agent and ~/.ssh defaults offer — which is how a
 * box already reachable from this machine's terminal is reachable from here
 * with nothing pasted at all. With a key, it is written to
 * DATA_DIR/keys/<plugin>-<accountId>.pem at 0600 before every use and left there,
 * because ssh will not read a private key from a pipe. That directory is
 * inside the data directory the whole repository gitignores, beside the vault
 * key that could decrypt it anyway.
 *
 * ONE SCRIPT, ONE ROUND TRIP. The probe below is POSIX sh sent on ssh's stdin
 * to `sh -s`, and it prints one JSON document. It is not a series of ssh calls
 * because each one is a TCP connection and a key exchange — eight of those per
 * box per half hour, on a domestic line, to read numbers that all come from
 * the same instant anyway. Sending a script also means NOTHING IS INSTALLED ON
 * THE BOX: no agent, no cron, no package. A box that stops being watched needs
 * nothing removed from it.
 *
 * WHAT THE PROBE MAY DO, AND THE LINE. It reads /proc, df, ps and — if docker
 * is installed — `docker ps`. It runs the owner's own `counters` commands and
 * nothing else. There is deliberately no route and no skill action that takes
 * a command: an agent that could name the command would have a root shell on
 * every box in this list, and "the agent is careful" is not an access control.
 * Counters are typed by a person into a settings field, which is where that
 * decision belongs.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { configValue, db, finishRun, now, record, startRun, syncPlugin } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { pruneOne, registerRetention, retentionFor } from "../../shared/retention.ts";

/* -------------------------------------------------------------- the target */

export type SshTarget = { user: string; host: string; port: number | null };

const SSH = /^([a-z0-9_][a-z0-9._-]*)@([a-z0-9.-]+|\[[0-9a-f:]+\])(?::([0-9]{1,5}))?$/i;

/** `user@host` or `user@host:port`, and nothing else. A bare hostname is
 *  refused rather than defaulted to the owner's local username: a probe that
 *  logs in as somebody the owner did not name is a probe whose failures are
 *  unreadable. */
export function parseSsh(value: string): SshTarget | null {
  const m = SSH.exec(value.trim());
  if (!m) return null;
  const port = m[3] ? Number(m[3]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { user: m[1]!, host: m[2]!, port };
}

/** How it is written back to a person. */
export function sshLabel(t: SshTarget): string {
  return `${t.user}@${t.host}${t.port ? `:${t.port}` : ""}`;
}

/* ------------------------------------------------------------- the key file */

export function keysDir(): string {
  const dir = join(DATA_DIR, "keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * THE PLUGINS THAT KEEP A PRIVATE KEY ON DISK, and the reason this list has to
 * exist.
 *
 * The key file used to be named `fleet-<accountId>.pem` FOR EVERY WRITER —
 * including `workstation`, whose account ids come out of a different plugin's
 * list entirely. The reaper below then walked the directory once per fleet
 * collection, found a file named for an id that was not in
 * `accounts.list("fleet")`, and deleted it. Every half hour it deleted the
 * workstation's key.
 *
 * IT WAS MASKED, NOT ABSENT. `workstation.ts` rewrites the file immediately
 * before every use — the vault is the record and the file is a cache of it —
 * so the deletion never showed. Anything that reads the path WITHOUT writing
 * first was one step from a failure that would have looked like a broken key:
 * `backups.ts` rebuilt the same path by hand and only `existsSync`'d it, so an
 * rsync to a box the owner had already pasted a key for would simply have
 * stopped finding one.
 *
 * So the file is keyed by PLUGIN AND ACCOUNT, and the reaper takes the union
 * of every plugin here. A plugin missing from this list has its key files left
 * alone rather than deleted — a stale 0600 file in a gitignored directory is a
 * smaller wrong than deleting a key something is using — and the reaper says
 * it found them.
 */
export const KEY_PLUGINS = ["fleet", "workstation"] as const;
export type KeyPlugin = (typeof KEY_PLUGINS)[number];

export function keyPath(plugin: KeyPlugin, accountId: number): string {
  return join(keysDir(), `${plugin}-${accountId}.pem`);
}

/**
 * Put the key on disk where ssh can read it.
 *
 * Rewritten before every use rather than written once, because the vault is
 * the record and this file is a cache of it: an owner who replaces a key
 * expects the next collection to use the new one, and a stale 0600 file that
 * still works is the worst possible version of that.
 *
 * A key with no trailing newline is given one. OpenSSH refuses "invalid
 * format" on a PEM whose last line has no terminator, which is the single most
 * common way a perfectly good key pasted into a form fails.
 */
export function writeKeyFile(plugin: KeyPlugin, accountId: number, pem: string): string {
  const path = keyPath(plugin, accountId);
  writeFileSync(path, pem.endsWith("\n") ? pem : `${pem}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/**
 * Key files whose account no longer exists, deleted.
 *
 * Account deletion happens in routes/plugins.ts, which this area does not own
 * and must not edit — so the reaping is done here, on every collection, from
 * the one fact that is always true: a file named for a plugin's account id
 * that is not in THAT PLUGIN's list belongs to nobody. It is a private key
 * sitting in a directory, so "eventually" is not good enough on its own; the
 * collector runs every thirty minutes, and removing the account also removes
 * the only thing that could ever read the file again.
 *
 * IT TAKES THE UNION OF EVERY KEY-WRITING PLUGIN, which is the fix: reaping
 * one plugin's list while another plugin wrote into the same namespace is what
 * made this delete a live key every half hour.
 */
export function reapKeyFiles(): string[] {
  const live = new Map(KEY_PLUGINS.map((p) => [p as string, new Set(accounts.list(p).map((a) => a.id))]));
  const gone: string[] = [];
  for (const name of readdirSync(keysDir())) {
    const m = /^([a-z]+)-(\d+)\.pem$/.exec(name);
    /* A NAME THIS FUNCTION DOES NOT UNDERSTAND IS LEFT WHERE IT IS. The
       temporary `<plugin>-verify-<pid>-<ms>.pem` files a credential check
       writes do not match, and neither would a plugin somebody forgot to add
       to KEY_PLUGINS — and of the two wrong answers, leaving a stale 0600 file
       in a gitignored directory beats deleting a key in use. */
    const owners = m ? live.get(m[1]!) : undefined;
    if (!m || !owners) continue;
    if (owners.has(Number(m[2]))) continue;
    rmSync(join(keysDir(), name), { force: true });
    gone.push(name);
  }
  return gone;
}

/* ------------------------------------------------------------------ counters */

export type Counter = { label: string; command: string };

/**
 * The owner's own measurements, one per line: `label = command`.
 *
 * THE SAME LINES RUN ON EVERY BOX, and that is the decision this format makes.
 * A per-box syntax was the alternative — `label @ box = command` — and it was
 * declined because settings are per PLUGIN here rather than per account, so
 * every line would have carried a box name that has to be kept in step with an
 * account label the owner can rename in another form. Running everywhere is
 * also usually what is wanted: "how many rows in the queue" is a question
 * asked of whichever box has a queue, and on the ones that have none the
 * command fails and is reported as failed on that box rather than as a zero.
 *
 * The value is the FIRST numeric token in the output of a command that EXITED
 * ZERO, so `wc -l < /var/log/x`, `docker ps -q | wc -l` and a bare `echo 42`
 * all work. A command that failed, or that printed no number, is a counter
 * with a null value and its output beside it — never a zero, and never a digit
 * scraped out of "command not found: /opt/tool-502".
 */
export function parseCounters(raw: string | null | undefined): Counter[] {
  const out: Counter[] = [];
  for (const line of (raw ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const at = t.indexOf("=");
    if (at < 1) continue;
    const label = t.slice(0, at).trim();
    const command = t.slice(at + 1).trim();
    if (!label || !command) continue;
    out.push({ label, command });
  }
  return out;
}

/** What is wrong with this counter list, said where it was typed. */
export function checkCounters(raw: string): string | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const line of lines) {
    const at = line.indexOf("=");
    if (at < 1)
      return `“${line.slice(0, 40)}” is not a counter. Each line is “label = shell command”.`;
    const label = line.slice(0, at).trim();
    if (!/^[\w .:-]{1,40}$/.test(label))
      return `“${label}” is not a usable label: letters, digits, spaces, dots, colons, dashes and underscores, up to 40 characters.`;
    if (!line.slice(at + 1).trim()) return `“${label}” has no command after the “=”.`;
  }
  const labels = lines.map((l) => l.slice(0, l.indexOf("=")).trim());
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) return `“${dup}” is listed twice. Two counters with one name make a chart nobody can read.`;
  return null;
}

/* -------------------------------------------------------------- the probe */

/**
 * ONE POSIX sh SCRIPT, printing ONE JSON DOCUMENT.
 *
 * String.raw, deliberately: the script is full of backslashes (awk's own
 * escaping of the JSON it emits) and a template literal would eat them. It
 * contains no backtick and no `$`-brace for the same reason — both would be
 * read by JavaScript before sh ever saw them.
 *
 * LINUX IS THE TARGET AND macOS IS A FALLBACK. Every figure is read from /proc
 * first, because that is where the servers are; where /proc is absent the same
 * figure is read from sysctl and vm_stat, which is what makes "add this
 * laptop" a thing an owner can do to see the shape of the page before pointing
 * it at anything that matters. A figure neither door can answer is emitted as
 * `null` — never as 0.
 *
 * PSEUDO FILESYSTEMS ARE NOT DISKS AND ARE LEFT OUT. devfs, tmpfs, /run,
 * /sys and the rest are always exactly full and cannot be acted on, so a
 * "fullest disk" line that named /dev at 100% would be a permanent false
 * alarm that trains the owner to ignore the real one. Docker's `overlay`
 * mounts go too: they are a second view of space the underlying disk already
 * reported.
 *
 * EVERY BYTE FIGURE IS PRINTED WITH %.0f AND NEVER %d, and that is a bug fix
 * rather than a style. awk's `%d` goes through a C int on mawk, which is what
 * Debian and Raspberry Pi OS ship as `awk` — so a Pi with 8 GB of RAM and a
 * 115 GB card reported 2,147,483,647 bytes for both, saturated at INT32_MAX,
 * and the fleet page drew that box's memory as 0% used and its disk as exactly
 * half full. `%.0f` goes through a double, which holds every byte count any
 * machine here will ever have.
 *
 * CPU IS SAMPLED OVER A SECOND, and it costs the probe that second per box.
 * /proc/stat holds counters since boot, so ONE read of it is the machine's
 * whole life averaged — a number that never moves. Two reads a second apart
 * are the utilisation of that second, which is the question. Nine seconds
 * added to a collection that runs every thirty minutes is the price.
 *
 * MEMORY IS BYTES EVERYWHERE. /proc/meminfo is kB and vm_stat is pages, and
 * both are converted here rather than downstream, so nothing above this line
 * has to know which kind of machine answered. `mem_used` is total minus
 * AVAILABLE rather than minus free — Linux's page cache is not memory anybody
 * is short of, and a "94% used" that is mostly cache is the classic way a
 * server dashboard cries wolf.
 */
export const PROBE = String.raw`
LC_ALL=C
export LC_ALL
PATH=$PATH:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin
export PATH

j() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '[:cntrl:]'; }
n() { if [ -z "$1" ]; then printf 'null'; else printf '%s' "$1"; fi; }

HOST_N=$(hostname 2>/dev/null || uname -n 2>/dev/null)
KERNEL=$(uname -sr 2>/dev/null)
UP_S=
L1=
L5=
L15=
CPUS=
MT=
MU=
MA=
ST=
SU=

if [ -r /proc/uptime ]; then
  UP_S=$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null)
fi
if [ -r /proc/loadavg ]; then
  L1=$(awk '{print $1+0}' /proc/loadavg 2>/dev/null)
  L5=$(awk '{print $2+0}' /proc/loadavg 2>/dev/null)
  L15=$(awk '{print $3+0}' /proc/loadavg 2>/dev/null)
fi
if [ -r /proc/cpuinfo ]; then
  CPUS=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)
fi
if [ -r /proc/meminfo ]; then
  MT=$(awk '/^MemTotal:/ {printf "%.0f", $2*1024}' /proc/meminfo 2>/dev/null)
  MA=$(awk '/^MemAvailable:/ {printf "%.0f", $2*1024}' /proc/meminfo 2>/dev/null)
  if [ -z "$MA" ]; then
    MA=$(awk '/^MemFree:/ {printf "%.0f", $2*1024}' /proc/meminfo 2>/dev/null)
  fi
  ST=$(awk '/^SwapTotal:/ {printf "%.0f", $2*1024}' /proc/meminfo 2>/dev/null)
  SF=$(awk '/^SwapFree:/ {printf "%.0f", $2*1024}' /proc/meminfo 2>/dev/null)
  if [ -n "$MT" ] && [ -n "$MA" ]; then MU=$((MT - MA)); fi
  if [ -n "$ST" ] && [ -n "$SF" ]; then SU=$((ST - SF)); fi
fi

if [ -z "$UP_S" ]; then
  # The FIRST number on the line, which is the seconds field. A pattern
  # anchored on "sec" matches "usec" too — greedily, and the resulting
  # "uptime" is then within a second of the current epoch, which is a wrong
  # answer that looks like a right one.
  BSEC=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\).*/\1/p')
  if [ -n "$BSEC" ]; then UP_S=$(( $(date +%s) - BSEC )); fi
fi
if [ -z "$L1" ]; then
  LA=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')
  L1=$(printf '%s' "$LA" | awk '{print $1+0}')
  L5=$(printf '%s' "$LA" | awk '{print $2+0}')
  L15=$(printf '%s' "$LA" | awk '{print $3+0}')
fi
if [ -z "$CPUS" ]; then CPUS=$(sysctl -n hw.ncpu 2>/dev/null); fi
if [ -z "$MT" ]; then
  MT=$(sysctl -n hw.memsize 2>/dev/null)
  PG=$(sysctl -n hw.pagesize 2>/dev/null)
  if [ -n "$PG" ]; then
    MA=$(vm_stat 2>/dev/null | awk -v p=$PG '/Pages free/ {gsub(/[^0-9]/,"",$NF); f=$NF} /Pages inactive/ {gsub(/[^0-9]/,"",$NF); i=$NF} /Pages speculative/ {gsub(/[^0-9]/,"",$NF); s=$NF} END {if (p != "") printf "%.0f", (f+i+s)*p}')
  fi
  if [ -n "$MT" ] && [ -n "$MA" ]; then MU=$((MT - MA)); fi
  SW=$(sysctl -n vm.swapusage 2>/dev/null)
  if [ -n "$SW" ]; then
    ST=$(printf '%s' "$SW" | awk '{for(i=1;i<=NF;i++) if ($i == "total") {v=$(i+2); sub(/[A-Za-z]$/,"",v); printf "%.0f", v*1048576}}')
    SU=$(printf '%s' "$SW" | awk '{for(i=1;i<=NF;i++) if ($i == "used") {v=$(i+2); sub(/[A-Za-z]$/,"",v); printf "%.0f", v*1048576}}')
  fi
fi

# HOW BUSY THE CPU IS, sampled over a second, because /proc/stat is a set of
# COUNTERS SINCE BOOT and one read of it is a machine's whole life averaged —
# a figure that never moves and answers nothing. Two reads a second apart give
# the utilisation of that second, which is what "is this box busy" means.
#
# IOWAIT COUNTS AS IDLE. A core blocked on a disk is not a core doing work, and
# lumping it into "busy" turns a slow volume into a CPU alarm — the one
# misreading that would make this figure worse than not having it.
#
# The macOS door is ps, summed and divided by the core count. It is an
# APPROXIMATION and the route says so: ps reports each process's average over
# its own lifetime, not over the last second.
CPU=
if [ -r /proc/stat ]; then
  CS1=$(awk '/^cpu / {idle=$5+$6; tot=0; for (i=2;i<=NF;i++) tot+=$i; printf "%.0f %.0f", idle, tot; exit}' /proc/stat 2>/dev/null)
  sleep 1
  CS2=$(awk '/^cpu / {idle=$5+$6; tot=0; for (i=2;i<=NF;i++) tot+=$i; printf "%.0f %.0f", idle, tot; exit}' /proc/stat 2>/dev/null)
  CPU=$(printf '%s %s' "$CS1" "$CS2" | awk 'NF==4 {di=$3-$1; dt=$4-$2; if (dt>0) {v=(1-di/dt)*100; if (v<0) v=0; if (v>100) v=100; printf "%.1f", v}}')
fi
if [ -z "$CPU" ]; then
  CPU=$(ps -A -o %cpu= 2>/dev/null | awk -v c="$CPUS" '{s+=$1} END {if (c+0>0) {v=s/(c+0); if (v>100) v=100; printf "%.1f", v}}')
fi

DISKS=$(df -Pk 2>/dev/null | awk 'NR>1 && $2+0>0 && $1 !~ /^(devfs|map|tmpfs|devtmpfs|udev|none|overlay|shm)$/ && $6 !~ /^\/(dev|proc|sys|run)($|\/)/ { m=$6; for(i=7;i<=NF;i++) m=m" "$i; gsub(/\\/,"\\\\",m); gsub(/"/,"\\\"",m); printf "%s{\"mount\":\"%s\",\"size\":%.0f,\"used\":%.0f,\"avail\":%.0f}", (c++?",":""), m, $2*1024, $3*1024, $4*1024 }')

DOCKER=0
CONTS=
if command -v docker >/dev/null 2>&1; then
  DOCKER=1
  CONTS=$(docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.RunningFor}}' 2>/dev/null | awk -F'|' 'NF>=4 { for (k=1;k<=4;k++) { gsub(/\\/,"\\\\",$k); gsub(/"/,"\\\"",$k) } printf "%s{\"name\":\"%s\",\"image\":\"%s\",\"status\":\"%s\",\"since\":\"%s\"}", (c++?",":""), $1, $2, $3, $4 }')
fi

PROCS=$(ps -eo pcpu,pmem,comm 2>/dev/null | awk 'NR>1' | sort -rn | head -5 | awk 'NF>=3 { c=$3; for(i=4;i<=NF;i++) c=c" "$i; gsub(/\\/,"\\\\",c); gsub(/"/,"\\\"",c); printf "%s{\"cpu\":%.1f,\"mem\":%.1f,\"command\":\"%s\"}", (k++?",":""), $1+0, $2+0, c }')

COUNTERS=
cadd() {
  cl=$1
  cc=$2
  cout=$(eval "$cc" 2>&1)
  crc=$?
  # ONLY A COMMAND THAT SUCCEEDED HAS A VALUE. stderr is captured so the owner
  # can see why a counter broke, and "command not found: /tmp/x-502/y" carries
  # digits that a first-number scan would happily report as the measurement.
  cval=
  if [ "$crc" = 0 ]; then
    cval=$(printf '%s' "$cout" | tr -cs '0-9.' ' ' | awk '{for(i=1;i<=NF;i++) if ($i ~ /^[0-9]+([.][0-9]+)?$/) {print $i; exit}}')
  fi
  craw=$(printf '%s' "$cout" | tr -d '[:cntrl:]' | cut -c1-200)
  centry=$(printf '{"label":"%s","value":%s,"exit":%s,"raw":"%s"}' "$(j "$cl")" "$(n "$cval")" "$crc" "$(j "$craw")")
  if [ -z "$COUNTERS" ]; then COUNTERS=$centry; else COUNTERS=$COUNTERS,$centry; fi
}

__COUNTERS__

printf '{'
printf '"hostname":"%s",' "$(j "$HOST_N")"
printf '"kernel":"%s",' "$(j "$KERNEL")"
printf '"uptime_s":%s,' "$(n "$UP_S")"
printf '"load1":%s,"load5":%s,"load15":%s,' "$(n "$L1")" "$(n "$L5")" "$(n "$L15")"
printf '"cpus":%s,' "$(n "$CPUS")"
printf '"cpu_pct":%s,' "$(n "$CPU")"
printf '"mem_total":%s,"mem_used":%s,"mem_avail":%s,' "$(n "$MT")" "$(n "$MU")" "$(n "$MA")"
printf '"swap_total":%s,"swap_used":%s,' "$(n "$ST")" "$(n "$SU")"
printf '"docker":%s,' "$DOCKER"
printf '"disks":[%s],' "$DISKS"
printf '"containers":[%s],' "$CONTS"
printf '"procs":[%s],' "$PROCS"
printf '"counters":[%s]' "$COUNTERS"
printf '}
'
`;

/** The owner's counter lines, quoted into the script as arguments to `cadd`.
 *  Single quotes with the sh escape for an embedded quote, which is the only
 *  form that cannot be broken out of. */
export function probeScript(counters: Counter[]): string {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  const lines = counters.map((c) => `cadd ${q(c.label)} ${q(c.command)}`).join("\n");
  return PROBE.replace("__COUNTERS__", lines);
}

/* --------------------------------------------------------------- ssh itself */

export type Probe = {
  hostname: string | null;
  kernel: string | null;
  uptime_s: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  cpus: number | null;
  /** Percent busy over one sampled second. Null on a box neither door could
   *  answer for, which is NOT an idle CPU. */
  cpu_pct: number | null;
  mem_total: number | null;
  mem_used: number | null;
  mem_avail: number | null;
  swap_total: number | null;
  swap_used: number | null;
  docker: number | null;
  disks: { mount: string; size: number; used: number; avail: number }[];
  containers: { name: string; image: string; status: string; since: string }[];
  procs: { cpu: number; mem: number; command: string }[];
  counters: { label: string; value: number | null; exit: number; raw: string }[];
};

/** How long one box gets, key exchange included. Generous, because a Pi over a
 *  home connection with a cold ssh is genuinely slow, and bounded, because a
 *  hung box must not hold up the rest of the fleet. */
const SSH_TIMEOUT_MS = 45_000;

function sshArgs(t: SshTarget, keyFile: string | null): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=accept-new",
    ...(keyFile ? ["-i", keyFile, "-o", "IdentitiesOnly=yes"] : []),
    ...(t.port ? ["-p", String(t.port)] : []),
    `${t.user}@${t.host}`,
  ];
}

export type Ran = { code: number | null; stdout: string; stderr: string; ms: number };

/** ssh, with the script on stdin. Never throws: a spawn that fails is a
 *  non-zero code and a message, because every caller here has to report a
 *  failure per box rather than lose the fleet to one of them. */
export function ssh(t: SshTarget, keyFile: string | null, script: string): Promise<Ran> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("ssh", [...sshArgs(t, keyFile), "sh", "-s"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr: stderr.trim(), ms: Date.now() - started });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\ntimed out after ${SSH_TIMEOUT_MS / 1000}s`;
      done(null);
    }, SSH_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      clearTimeout(timer);
      done(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code);
    });

    child.stdin.on("error", () => {});
    child.stdin.end(script);
  });
}

/**
 * ssh's own failures, translated.
 *
 * ssh says "Permission denied (publickey)" and expects you to know which of
 * six things that means. The owner is being asked to fix one of them, so the
 * message names the likely one — and never invents a diagnosis it does not
 * have, which is why the raw stderr is always appended.
 */
export function sshProblem(ran: Ran, hasKey: boolean): string {
  const err = ran.stderr;
  const tail = err.split("\n").filter(Boolean).slice(-2).join(" ").trim();
  if (/permission denied|no supported authentication/i.test(err))
    return hasKey
      ? `The box refused the key. Check the public half is in that user's ~/.ssh/authorized_keys, and that the key has no passphrase — ssh runs here with no terminal to ask for one. (${tail})`
      : `The box refused this machine's own keys, and no key was pasted for it. Either add one on this account, or put this machine's public key in that user's ~/.ssh/authorized_keys. (${tail})`;
  if (/host key verification failed/i.test(err))
    return `The host key changed since this machine last connected. Fix it in ~/.ssh/known_hosts by hand — accepting a changed host key automatically is exactly what host keys exist to prevent. (${tail})`;
  if (/could not resolve|name or service not known|nodename nor servname/i.test(err))
    return `That hostname does not resolve from here. (${tail})`;
  if (/connection refused/i.test(err))
    return `Nothing is listening for ssh at that address and port. (${tail})`;
  if (/connection timed out|operation timed out|timed out after/i.test(err))
    return `The box did not answer in time. (${tail})`;
  if (/invalid format|libcrypto|bad permissions/i.test(err))
    return `OpenSSH would not read the key — paste the PRIVATE half, whole, including its BEGIN and END lines. (${tail})`;
  return tail || `ssh exited ${ran.code ?? "without a status"}.`;
}

/** Run the probe against one target. `error` is set exactly when `probe` is
 *  null; both being null never happens. */
export async function probe(
  t: SshTarget,
  keyFile: string | null,
  counters: Counter[],
): Promise<{ probe: Probe | null; error: string | null; ms: number; stderr: string }> {
  const ran = await ssh(t, keyFile, probeScript(counters));
  if (ran.code !== 0 || !ran.stdout.trim())
    return { probe: null, error: sshProblem(ran, keyFile !== null), ms: ran.ms, stderr: ran.stderr };
  try {
    /* The last line, because a login shell that prints a banner to stdout
       would otherwise poison a perfectly good document. */
    const line = ran.stdout.trim().split("\n").at(-1)!;
    return { probe: JSON.parse(line) as Probe, error: null, ms: ran.ms, stderr: ran.stderr };
  } catch {
    return {
      probe: null,
      error:
        "The box answered, but not with the document the probe prints. Its shell may be printing a banner, or /bin/sh there is not a POSIX shell.",
      ms: ran.ms,
      stderr: ran.stderr,
    };
  }
}

/**
 * Verify, for the credential registry.
 *
 * `echo ok` and nothing more — the whole question at this point is whether
 * this machine can log in, and running the full probe would confuse "the key
 * is wrong" with "this box has no /proc". The key is written to a temporary
 * file because there is no account row yet: verification happens BEFORE the
 * account exists, so a refused credential leaves nothing behind at all.
 */
export async function verify(values: Record<string, string>): Promise<string | null> {
  const raw = (values.host ?? "").trim();
  if (!raw) return "Type the box as user@host — for example root@203.0.113.10, or pi@pi.local:2222.";
  const t = parseSsh(raw);
  if (!t)
    return `“${raw}” is not an ssh target. It is user@host, optionally with :port — no scheme, no path.`;

  const key = (values.key ?? "").trim();
  let keyFile: string | null = null;
  if (key) {
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key))
      return "That is not a private key. Paste the PRIVATE half — the file without .pub — whole, including its BEGIN and END lines.";
    if (/ENCRYPTED/.test(key))
      return "That key has a passphrase. This runs with no terminal to type one into, so it needs a key with no passphrase — make a separate one for this box if you would rather not unlock the one you use by hand.";
    keyFile = join(keysDir(), `fleet-verify-${process.pid}-${Date.now()}.pem`);
    writeFileSync(keyFile, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
  }

  try {
    const ran = await ssh(t, keyFile, "echo ok\n");
    if (ran.code === 0 && ran.stdout.includes("ok")) return null;
    return sshProblem(ran, keyFile !== null);
  } finally {
    if (keyFile) rmSync(keyFile, { force: true });
  }
}

/* -------------------------------------------------------------------- store */

export const RETAIN_DAYS = 30;
/* THREE TABLES, ONE WINDOW, THREE ENTRIES. The registry is keyed on the table
   because that is the unit a prune deletes from and the unit a reader asks
   about — "how long are disks kept" has to have an answer even though disks,
   samples and containers happen to share a number today. */
for (const table of ["fleet_samples", "fleet_disks", "fleet_containers"])
  registerRetention({
    table,
    column: "ts",
    days: RETAIN_DAYS,
    source: "area",
    note:
      "A probe every half hour per box. Thirty days is “was it busy last night” and “has this been " +
      "climbing all week”, which is what these figures are read for; a year of half-hourly samples " +
      "would be a million rows answering nothing better.",
  });

export function writeSample(accountId: number, ts: string, p: Probe) {
  db.prepare(
    `INSERT INTO fleet_samples
       (account_id, ts, load1, load5, load15, cpus, cpu_pct, mem_total, mem_used,
        mem_avail, swap_total, swap_used, uptime_s)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, ts) DO NOTHING`,
  ).run(
    accountId, ts, p.load1, p.load5, p.load15, p.cpus,
    /* A probe that printed no number leaves the column NULL rather than 0 —
       "not measured" and "idle" are two different mornings. */
    Number.isFinite(p.cpu_pct as number) ? p.cpu_pct : null,
    p.mem_total, p.mem_used,
    p.mem_avail, p.swap_total, p.swap_used, p.uptime_s,
  );

  const disk = db.prepare(
    `INSERT INTO fleet_disks (account_id, ts, mount, size, used, avail)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, ts, mount) DO NOTHING`,
  );
  for (const d of p.disks ?? []) disk.run(accountId, ts, d.mount, d.size, d.used, d.avail);

  const container = db.prepare(
    `INSERT INTO fleet_containers (account_id, ts, name, image, status, since)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, ts, name) DO NOTHING`,
  );
  for (const ct of p.containers ?? [])
    container.run(accountId, ts, ct.name, ct.image, ct.status, ct.since);
}

export function writeHost(
  accountId: number,
  fields: {
    hostname: string | null;
    kernel: string | null;
    docker: number | null;
    /** user@host as the vault holds it — a cache, see 044_fleet_target. */
    target: string | null;
    ok: boolean;
    error: string | null;
  },
) {
  const ts = now();
  db.prepare(
    `INSERT INTO fleet_hosts
       (account_id, hostname, kernel, docker, target, seen_at, ok_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       -- A failed probe keeps the identity it last reported. "The box stopped
       -- answering" is news about the connection, not news that the box has
       -- no name.
       hostname = COALESCE(excluded.hostname, fleet_hosts.hostname),
       kernel   = COALESCE(excluded.kernel, fleet_hosts.kernel),
       docker   = COALESCE(excluded.docker, fleet_hosts.docker),
       target   = COALESCE(excluded.target, fleet_hosts.target),
       seen_at  = excluded.seen_at,
       ok_at    = COALESCE(excluded.ok_at, fleet_hosts.ok_at),
       error    = excluded.error`,
  ).run(
    accountId,
    fields.hostname,
    fields.kernel,
    fields.docker,
    fields.target,
    ts,
    fields.ok ? ts : null,
    fields.error,
  );
}

/** A row whose account is gone takes its samples with it — otherwise a box
 *  that was removed goes on counting inside "memory across the fleet". */
export function forgetGoneAccounts(): number {
  const live = accounts.list("fleet").map((a) => a.id);
  const holes = (
    db.prepare("SELECT DISTINCT account_id FROM fleet_hosts").all() as unknown as {
      account_id: number;
    }[]
  )
    .map((r) => r.account_id)
    .filter((id) => !live.includes(id));
  let gone = 0;
  for (const id of holes)
    for (const table of ["fleet_samples", "fleet_disks", "fleet_containers", "fleet_hosts"])
      gone += Number(db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(id).changes);
  return gone;
}

export type SampleRow = {
  account_id: number;
  ts: string;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  cpus: number | null;
  cpu_pct: number | null;
  mem_total: number | null;
  mem_used: number | null;
  mem_avail: number | null;
  swap_total: number | null;
  swap_used: number | null;
  uptime_s: number | null;
};

export type DiskRow = {
  account_id: number;
  ts: string;
  mount: string;
  size: number | null;
  used: number | null;
  avail: number | null;
};

export type ContainerRow = {
  account_id: number;
  ts: string;
  name: string;
  image: string | null;
  status: string | null;
  since: string | null;
};

export type HostRow = {
  account_id: number;
  hostname: string | null;
  kernel: string | null;
  docker: number | null;
  target: string | null;
  seen_at: string;
  ok_at: string | null;
  error: string | null;
};

export function samplesSince(hours: number): SampleRow[] {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  return db
    .prepare("SELECT * FROM fleet_samples WHERE ts >= ? ORDER BY ts ASC")
    .all(since) as unknown as SampleRow[];
}

export function latestDisks(): DiskRow[] {
  return db
    .prepare(
      `SELECT d.* FROM fleet_disks d
        JOIN (SELECT account_id, MAX(ts) AS ts FROM fleet_disks GROUP BY account_id) l
          ON l.account_id = d.account_id AND l.ts = d.ts
        ORDER BY d.account_id, d.mount`,
    )
    .all() as unknown as DiskRow[];
}

export function latestContainers(): ContainerRow[] {
  return db
    .prepare(
      `SELECT c.* FROM fleet_containers c
        JOIN (SELECT account_id, MAX(ts) AS ts FROM fleet_containers GROUP BY account_id) l
          ON l.account_id = c.account_id AND l.ts = c.ts
        ORDER BY c.account_id, c.name`,
    )
    .all() as unknown as ContainerRow[];
}

export function hostRows(): HostRow[] {
  return db.prepare("SELECT * FROM fleet_hosts").all() as unknown as HostRow[];
}

export function pruneSamples(): number {
  let gone = 0;
  for (const table of ["fleet_samples", "fleet_disks", "fleet_containers"]) gone += pruneOne(retentionFor(table)!);
  return gone;
}

/** The metric one counter's history lives under. Named here so the collector
 *  and the route cannot spell it differently. */
export function counterMetric(accountId: number, label: string): string {
  return `fleet.${accountId}.${label}`;
}

/* ---------------------------------------------------------------- collector */

export type FleetSummary = {
  ok: boolean;
  runId: number;
  boxes: number;
  answered: number;
  counters: number;
  pruned: number;
  reaped: string[];
  warnings: string[];
  error?: string | null;
  note?: string | null;
};

/**
 * Every box, probed once, ONE AT A TIME.
 *
 * Sequential because each probe is an ssh handshake and a shell, and four at
 * once on a domestic uplink measures this machine's contention rather than the
 * boxes'. It also keeps the failure output readable: one box, one error, in
 * the order the owner listed them.
 *
 * A BOX THAT FAILS IS THAT BOX'S ERROR. The account is marked failed and the
 * run continues; the run fails only when there is no account at all, or when
 * not one of them answered — which is a different sentence and gets a
 * different one.
 */
export async function collectFleet(): Promise<FleetSummary> {
  const runId = startRun("fleet");
  const reaped = reapKeyFiles();
  forgetGoneAccounts();
  const counters = parseCounters(configValue("fleet", "counters"));

  const { ready, broken } = accounts.credentialed("fleet", ["host"], "collect_fleet");
  const warnings = broken.map(
    (b) => `${b.account.label}: missing ${b.missing.join(", ")} — the account is connected but incomplete.`,
  );

  if (!ready.length && !broken.length) {
    const error = "No box is connected. Add one as user@host on the plugin page.";
    finishRun(runId, false, undefined, error);
    syncPlugin("fleet", error);
    return { ok: false, runId, boxes: 0, answered: 0, counters: 0, pruned: 0, reaped, warnings, error };
  }

  let answered = 0;
  let counterValues = 0;

  for (const { account, values } of ready) {
    const t = parseSsh(values.host ?? "");
    if (!t) {
      const error = `“${values.host}” is not an ssh target any more — it is user@host, optionally with :port.`;
      accounts.markFailed(account.id, error);
      writeHost(account.id, {
        hostname: null, kernel: null, docker: null,
        target: values.host ?? null, ok: false, error,
      });
      warnings.push(`${account.label}: ${error}`);
      continue;
    }

    const key = (values.key ?? "").trim();
    const keyFile = key ? writeKeyFile("fleet", account.id, key) : null;

    const result = await probe(t, keyFile, counters);
    if (!result.probe) {
      accounts.markFailed(account.id, result.error ?? "The box did not answer.");
      writeHost(account.id, {
        hostname: null, kernel: null, docker: null, target: sshLabel(t), ok: false,
        error: result.error ?? "The box did not answer.",
      });
      warnings.push(`${account.label}: ${result.error}`);
      continue;
    }

    const p = result.probe;
    const ts = now();
    writeSample(account.id, ts, p);
    writeHost(account.id, {
      hostname: p.hostname, kernel: p.kernel, target: sshLabel(t),
      docker: p.docker === null ? null : p.docker ? 1 : 0,
      ok: true, error: null,
    });
    accounts.markOk(account.id);
    answered += 1;

    for (const c of p.counters ?? []) {
      /* A counter that produced no number is NOT recorded as zero. There is no
         reading for it at all, which is what makes "the command broke" visible
         on the page as a gap rather than as a collapse to nothing. */
      if (c.value === null || !Number.isFinite(c.value)) {
        warnings.push(
          `${account.label} · ${c.label}: no number in the output` +
            (c.raw ? ` (“${c.raw.slice(0, 60)}”)` : ""),
        );
        continue;
      }
      record(counterMetric(account.id, c.label), c.value, { box: account.label, exit: c.exit });
      counterValues += 1;
    }
  }

  const pruned = pruneSamples();
  const boxes = ready.length + broken.length;

  if (!answered) {
    const error = warnings.join("; ") || "No box answered.";
    finishRun(runId, false, undefined, error);
    syncPlugin("fleet", error);
    return { ok: false, runId, boxes, answered, counters: counterValues, pruned, reaped, warnings, error };
  }

  const note =
    `${answered}/${boxes} box${boxes === 1 ? "" : "es"}` +
    (counters.length ? `, ${counterValues}/${counters.length * answered} counter value(s)` : "") +
    (pruned ? `, ${pruned} row(s) aged out` : "") +
    (reaped.length ? `, ${reaped.length} orphan key file(s) removed` : "");
  finishRun(runId, true, note, warnings.join("; ") || undefined);
  syncPlugin("fleet", warnings.join("; ") || null);

  return { ok: true, runId, boxes, answered, counters: counterValues, pruned, reaped, warnings, note };
}
