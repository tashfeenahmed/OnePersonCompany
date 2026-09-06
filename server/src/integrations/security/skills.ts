/**
 * The security area's skill entries.
 *
 * Types only from skills/registry.ts — importing it at value level would put
 * the registry inside the seam's own import graph, and its header says why that
 * must not happen.
 *
 * FOUR ENTRIES, AND ONE OF THEM IS ABOUT THE AGENT'S OWN DOOR. `security` is
 * unusual for this box: every other skill describes something MEASURED, and
 * this one describes the lock in front of everything else. It is here because
 * an agent that gets a 401 has to be able to find out why in one command
 * instead of concluding the dashboard is broken — and because "is there a
 * password on this thing" is a question the owner asks the chat.
 *
 * IT PUBLISHES NO WRITE ON THE PASSWORD, deliberately, and that is the line
 * this area draws. `security` has no actions at all: an agent cannot set,
 * change or remove the password, and cannot revoke a session. The skills proxy
 * carries the SERVICE KEY on every call it makes, so an action that could
 * remove the password would be an agent able to unlock the box it is standing
 * in — and the whole point of the key is that it opens the API, not the lock.
 * Two of the other three do have actions, and both change a machine's state
 * rather than this app's.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "security",
    title: "Security — the lock on this dashboard's own API",
    /* No plugin. Like the board, this is always live: the answer "there is no
       password" is as real as the answer "there is one". */
    plugins: [],
    about:
      "Whether this dashboard requires a password, when it was set, which browser sessions are signed in, and " +
      "where the service key file is. The API binds to 127.0.0.1 and has no authentication until the owner sets " +
      "a password; from that moment every request needs either a browser session or the service key — which the " +
      "`opc` command and the MCP server already send on every call.",
    rules: [
      "THIS IS A DOOR LOCK, NOT A USER SYSTEM. One password, one owner, no roles, no per-venture permissions and " +
        "no audit of who did what. Never describe it as multi-user or as access control.",
      "`enabled: false` means there is no password at all and /api is open to anything that can reach the port. " +
        "That is the shipped state and it is fine for a box on loopback; say so plainly rather than calling it a " +
        "vulnerability or a misconfiguration.",
      "Anything that can read the service key file has the whole API. It sits beside vault.key, which decrypts " +
        "every credential on the box, so the file's protection is the machine's — never quote the key itself and " +
        "never suggest putting it anywhere off this machine.",
      "A session in the list is a BROWSER, identified only by its user agent. It is not a person and not a device; " +
        "two browsers on one laptop are two sessions.",
      "There is no action here. You cannot set, change or remove the password or revoke a session from a chat, and " +
        "you should not offer to — that is the Security tab in Settings, which is a page a person is looking at.",
    ],
    views: [
      {
        key: "default",
        path: "/api/security/status",
        about: "Whether a password is set, how this request authenticated, and the browser sessions.",
        params: [],
      },
    ],
    asks: [
      "Does this dashboard have a password on it?",
      "Which browsers are still signed in?",
    ],
  },

  {
    id: "snapshots",
    title: "Snapshots — what a box was doing at one instant",
    plugins: ["fleet"],
    about:
      "A snapshot is everything a shell can say about one fleet box at ONE MOMENT: the fifteen heaviest processes " +
      "by CPU and by memory from a single ps, every listening socket, the count of established connections, df, " +
      "the last fifty lines of the system log, and docker ps. Taken on demand, or automatically when an uptime " +
      "host linked to the same venture as a box starts failing — at most one automatic capture per box per hour. " +
      "It reaches the boxes over the fleet plugin's own ssh accounts and adds no credential of its own.",
    rules: [
      "A SNAPSHOT IS AN INSTANT, NOT A TREND. Two snapshots of one box are two moments and NOTHING between them " +
        "was measured. Never draw a line between them, never say a figure “rose”, and never average them. The " +
        "trend data for a box is /api/fleet, which samples every thirty minutes.",
      "`cpu` on a process is its share of CPU SINCE THAT PROCESS STARTED, which is what ps reports — not a sample " +
        "over the last second. A daemon up for a month reads low while it is busy right now.",
      "An empty `ports.lines` with `tool: null` means the box had no ss, no netstat and no lsof. It is NOT a box " +
        "with nothing listening. The same rule holds for `logs` with `source: null` and for `connections." +
        "established: null`.",
      "`docker.installed: false` means docker is not on that user's PATH. It is not zero containers.",
      "A snapshot with `ok: false` is a real record of a box that WOULD NOT ANSWER at that moment, with the ssh " +
        "error on it. That is usually the most useful snapshot there is; do not report it as a missing snapshot.",
      "Everything here is what ONE ssh user could see. A socket, a process or a log that user has no permission " +
        "for is absent, and absence here is not evidence.",
      "Taking a snapshot opens an ssh connection to a real machine. It is not destructive and it installs nothing, " +
        "but it is a live connection to somebody's server — do not take them in a loop.",
    ],
    views: [
      {
        key: "default",
        path: "/api/snapshots",
        about: "The boxes that can be snapshotted and the recent snapshots, newest first. No documents.",
        params: [
          {
            name: "host",
            type: "string",
            required: false,
            in: "query",
            about: "A fleet account's label or id, to list only that box's snapshots.",
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 50,
            about: "How many snapshots to list. Clamped to 1–500.",
          },
        ],
      },
      {
        key: "one",
        path: "/api/snapshots/:id",
        about: "One whole snapshot document: processes, ports, connections, disks, the log tail and docker.",
        params: [
          {
            name: "id",
            type: "number",
            required: true,
            in: "path",
            about: "The snapshot's id, from the default view.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "take_now",
        method: "POST",
        path: "/api/snapshots/:host/now",
        about:
          "Capture one box right now over ssh and return the whole document. Takes a second or two on a healthy " +
          "box and up to forty-five on a sick one. It changes nothing on the machine — it runs a fixed read-only " +
          "script and installs nothing — but it does open a real ssh connection.",
        params: [
          {
            name: "host",
            type: "string",
            required: true,
            in: "path",
            about: "The fleet account's label or id.",
          },
          {
            name: "reason",
            type: "string",
            required: false,
            in: "body",
            about: "Why it was taken, stored with it. Say what you were investigating; “asked for” is the default.",
          },
        ],
      },
    ],
    asks: [
      "What was running on the Pi when it went down last night?",
      "What is listening on that box right now?",
    ],
  },

  {
    id: "shotsqa",
    title: "Screenshot QA — is the picture on each venture's card a picture of the site",
    plugins: [],
    about:
      "The last QA pass over every venture's screenshot: sensible dimensions, whether the image is a flat " +
      "rectangle rather than a page (luminance variance and dominant-colour share, decoded in this process), " +
      "error wording in the page title, what the latest audit says about http, and how stale the capture is. " +
      "One row per venture per pass. The full report is on the run at /api/runs/<runId>.",
    rules: [
      "THERE ARE THREE VERDICTS AND `unchecked` IS NEVER A PASS. It means the check could not be run at all — no " +
        "audit on file, no title ever read, the PNG pruned off disk, an image this decoder does not handle — and " +
        "every one says which in its own `detail`. Report unchecked as unchecked.",
      "NO MODEL LOOKS AT THESE PICTURES. There is no capability flag anywhere on this box saying whether a " +
        "configured provider can accept an image, so none is sent one. Every verdict is arithmetic over the PNG " +
        "and over two tables. Never imply anything looked at the picture.",
      "THE CHECKS ARE HEURISTICS. “Not blank” is a luminance standard deviation and a dominant-colour share; a " +
        "deliberately minimal page can fail it and a beautifully rendered wrong page passes everything here. A " +
        "pass is not a statement that the site is fine.",
      "The title check reads the title recorded by the rendered-DOM pass or by the audit crawl — which may be " +
        "from a different moment than the picture. The `detail` says which and when; quote it.",
      "A pass is a MOMENT. Comparing two passes tells you what changed between them and nothing about what " +
        "happened in between.",
    ],
    views: [
      {
        key: "default",
        path: "/api/shotsqa",
        about: "The newest pass: every venture, every check with its verdict and reason, plus the pass history.",
        params: [
          {
            name: "run",
            type: "string",
            required: false,
            in: "query",
            about: "A run id, to read that pass instead of the newest.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "run_now",
        method: "POST",
        path: "/api/shotsqa/run",
        about:
          "Queue a screenshot QA pass. It joins the single run queue, so it may wait behind other work; the " +
          "answer carries the run id and its status. It asks no model and costs no tokens.",
        params: [],
      },
    ],
    asks: [
      "Is any venture's screenshot actually a picture of an error page?",
      "Which screenshots are stale?",
    ],
  },

  {
    id: "workstation",
    title: "Workstation — the desk machine, and its power switch",
    plugins: ["workstation"],
    about:
      "One account is one machine on the owner's own desk. Whether it is reachable over ssh right now, how long " +
      "it has been up, and what nvidia-smi says about its GPUs — plus the reachability history the collector " +
      "writes every cycle. It can send a wake-on-LAN magic packet, and it can run the sleep or shutdown command " +
      "the owner typed into the plugin's settings.",
    rules: [
      "A MACHINE THAT IS NOT REACHABLE IS THE ORDINARY STATE OF A DESK MACHINE. It is not an incident, the " +
        "account is still connected, and the collector still succeeded. Do not report a sleeping desktop as a " +
        "failure.",
      "`gpus: null` means nvidia-smi did not answer — the machine was asleep, has no NVIDIA card, or the tool is " +
        "not installed — and `gpuNote` says which. It is NEVER a claim that the machine has no GPU, and it is " +
        "never zero GPUs.",
      "WAKE CANNOT BE CONFIRMED. Nothing acknowledges a magic packet. `sent` means the UDP broadcast left this " +
        "machine, nothing more. Say the packet was sent and that the state has to be asked for again.",
      "SLEEP AND SHUTDOWN RUN A COMMAND THE OWNER TYPED, and if none has been typed the call is refused with the " +
        "documented command for that OS. Nothing here composes a privileged command on its own.",
      "A machine going down usually kills the ssh connection before the shell reports a status, so a non-zero " +
        "exit on sleep or shutdown is NOT evidence it failed. The test is asking for the state again.",
      "`history` comes from the collector and is up to half an hour behind; the top-level state is read live on " +
        "the request. Do not mix them in one sentence.",
    ],
    views: [
      {
        key: "default",
        path: "/api/workstation",
        about: "Every connected machine: live reachability, uptime, GPUs, the power commands, and the history.",
        params: [
          {
            name: "hours",
            type: "number",
            required: false,
            fallback: 168,
            about: "How far back the reachability history goes. Clamped to 1–720.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "wake",
        method: "POST",
        path: "/api/workstation/:id/wake",
        about:
          "Send a wake-on-LAN magic packet to the machine's MAC address over UDP broadcast. It changes the state " +
          "of a physical machine — it turns a computer on — and it cannot be confirmed or undone from here.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The workstation account's label or id." },
        ],
      },
      {
        key: "sleep",
        method: "POST",
        path: "/api/workstation/:id/sleep",
        about:
          "Run the owner's sleep command on the machine over ssh. It changes the state of a physical machine: " +
          "anything unsaved on it is at the mercy of whatever it was doing. Refused with the documented command " +
          "for that OS when no command has been set.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The workstation account's label or id." },
        ],
      },
    ],
    asks: [
      "Is the desktop awake, and what is the GPU doing?",
      "Wake the studio machine.",
    ],
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  security: { name: "dashboard-security", category: "infrastructure" },
  snapshots: { name: "server-snapshots", category: "infrastructure" },
  shotsqa: { name: "screenshot-qa", category: "infrastructure" },
  workstation: { name: "workstation-power", category: "infrastructure" },
};
