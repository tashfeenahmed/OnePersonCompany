/**
 * /api/workstation — the desk machine: is it awake, wake it, put it back.
 *
 * FOUR ROUTES, THREE OF WHICH CHANGE THE STATE OF A PHYSICAL MACHINE. That is
 * unusual for this server, where nearly everything is a read of something a
 * collector wrote, and it is the reason each of them answers with what it
 * actually did rather than with a verdict: a magic packet is not an
 * acknowledgement, and an ssh that dies mid-suspend is not a failure. The page
 * and the agent are both told to ask again rather than to believe a claim
 * nothing on the wire supports.
 *
 * THE STATE IS READ LIVE, on every GET, and is not the collector's row. A
 * person opening this panel is asking whether the machine is up NOW; a figure
 * from up to half an hour ago is exactly the wrong answer to that. The
 * collector's history is on the same document beside it, labelled as history.
 */
import { Hono } from "hono";
import {
  DOCUMENTED,
  findMachine,
  leaseResource,
  machines,
  noCommandYet,
  power,
  powerCommand,
  readState,
  sendMagicPacket,
  statesSince,
} from "./workstation.ts";
/*
  THE LEASE REGISTRY, AND WHY A POWER ROUTE CONSULTS IT.

  These four routes are the only thing on this box that can turn a machine off,
  and until now the only question they asked was whether the owner had typed a
  command. That is the right question for "is this allowed" and the wrong one
  for "is this a good idea": a desk machine is shared infrastructure, and the
  half-hour render that this route can end has no way to object. So sleep now
  asks integrations/deploy/leases.ts first, and wake records who woke it —
  because a machine this app did not wake is one it has no business sleeping.
*/
import { recordWake, sleepCheck } from "../deploy/leases.ts";

export const workstationRoutes = new Hono();

/** The live state of every connected machine, plus the recent history. */
workstationRoutes.get("/", async (c) => {
  const hours = Math.min(Math.max(Number(c.req.query("hours") ?? 168) || 168, 1), 720);
  const { ready, problems } = machines();
  const states = await Promise.all(ready.map((m) => readState(m)));
  const history = statesSince(hours);

  return c.json({
    machines: states.map((s) => ({
      ...s,
      history: history
        .filter((h) => h.account_id === s.id)
        .map((h) => ({ ts: h.ts, reachable: h.reachable === 1, uptimeS: h.uptime_s })),
    })),
    problems,
    commands: {
      sleep: powerCommand("sleep"),
      shutdown: powerCommand("shutdown"),
      documented: DOCUMENTED,
      note:
        "Nothing here runs a power command until one has been typed in the plugin's settings. There is no per-OS " +
        "table that this route will fall back to — whether suspending needs sudo depends on the machine's own " +
        "policy, and a dashboard guessing at that is a dashboard halting the wrong thing.",
    },
    windowHours: hours,
    note:
      "The state is read LIVE over ssh on this request; `history` is the collector's row per cycle and is up to " +
      "half an hour behind. `reachable: false` is the ordinary state of a desk machine and is not a fault — the " +
      "account stays connected. `gpus: null` means nvidia-smi did not answer, with the reason in `gpuNote`; it is " +
      "never a claim that the machine has no GPU.",
  });
});

/**
 * WAKE. A UDP broadcast and nothing else — no credential, no ssh, nothing on
 * the machine. It cannot be confirmed and this route never claims it was.
 */
workstationRoutes.post("/:id/wake", async (c) => {
  const m = findMachine(c.req.param("id"));
  if (!m) return c.json({ error: `No connected workstation is called “${c.req.param("id")}”.` }, 404);
  if (!m.mac)
    return c.json(
      {
        error:
          `${m.label} has no MAC address on file, and a magic packet is addressed by MAC. ` +
          `Add it to the account — it is the WIRED adapter's address; wake-on-LAN over wifi does not work on most machines.`,
      },
      400,
    );

  /*
    WHAT WAS TRUE BEFORE THE PACKET WENT, read here and not inferred later.

    Ownership is decided by the state the machine was in at the moment of the
    wake: a machine that was already answering is up for somebody else's
    reasons, and this app is a guest that leaves it running. Asking afterwards
    could not tell the two apart. It costs one ssh attempt against a machine
    that is probably asleep, which is the same attempt the state route makes.
  */
  const before = await readState(m);
  const res = await sendMagicPacket(m.mac, m.broadcast);
  if (res.error) return c.json({ ok: false, error: `The packet could not be sent: ${res.error}` }, 502);
  const wake = recordWake({
    resource: leaseResource(m),
    by: "the workstation wake button",
    foundState: before.reachable ? "awake" : "asleep",
  });

  return c.json({
    ok: true,
    sent: res.sent,
    wake,
    to: m.broadcast,
    mac: m.mac.map((b) => b.toString(16).padStart(2, "0")).join(":"),
    note:
      "The packet was sent. NOTHING ACKNOWLEDGES A MAGIC PACKET, so this is not a claim that the machine woke — " +
      "ask for the state again in thirty seconds. If it never wakes: wake-on-LAN has to be enabled in the machine's " +
      "firmware AND in its operating system, it usually only works on the wired adapter, and a broadcast that is " +
      "filtered by the network needs the subnet address (192.168.1.255) rather than the default.",
  });
});

/** SLEEP and SHUTDOWN, over ssh, with the command the owner typed. */
for (const action of ["sleep", "shutdown"] as const) {
  workstationRoutes.post(`/:id/${action}`, async (c) => {
    const m = findMachine(c.req.param("id"));
    if (!m) return c.json({ error: `No connected workstation is called “${c.req.param("id")}”.` }, 404);

    /*
      NOBODY SLEEPS A BUSY BOX, and nothing powers off a machine it did not
      power on. Both refusals come from one function so that this route and the
      `leases` skill say the same words; see integrations/deploy/leases.ts.
      SHUTDOWN IS CHECKED TOO — it is the more irreversible of the two, and a
      render killed by a poweroff is no less killed for the verb being
      different. The owner can override from the Deployment page by releasing
      the lease, which is a decision with a record rather than a flag on a URL.
    */
    if (action === "sleep" || action === "shutdown") {
      const check = sleepCheck(leaseResource(m));
      if (!check.allowed)
        return c.json({ ok: false, error: check.refusal, reason: check.reason, holders: check.holders, wake: check.wake }, 409);
    }

    const command = powerCommand(action);
    if (!command)
      /* NOTHING IS SSH'd TO FIND OUT THE OS FIRST. This branch is about a
         settings field that is empty, and an eight-second connect attempt to a
         machine that is probably asleep would delay a message that has nothing
         to do with the machine. `noCommandYet` lists every documented command
         when it does not know which OS to name. */
      return c.json({ error: noCommandYet(action, null), documented: DOCUMENTED }, 400);

    const res = await power(m, action, command);
    return c.json(res);
  });
}
