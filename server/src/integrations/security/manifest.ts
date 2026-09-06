/**
 * SECURITY — the door, and three things that are about the machines rather than
 * about the businesses.
 *
 * IT IS ONE AREA AND NOT FOUR, AND THE THREAD IS "THIS BOX AND THE MACHINES
 * AROUND IT". Everything else on this seam measures a business: analytics,
 * ops, signals, ventures, runs. This one holds the lock on the dashboard's own
 * API, a way to photograph a server at the moment it went wrong, a QA pass over
 * the pictures the dashboard shows of the businesses, and the desk machine's
 * power switch. None of them is a measurement of a venture, and each of them
 * would be a lonely area of its own.
 *
 * ONE CREDENTIALED PLUGIN AND NO OTHERS. `workstation` holds one account per
 * machine — an ssh target, an optional key, an optional MAC and an optional
 * broadcast address. Snapshots deliberately hold NO credential: they reach the
 * boxes over the `fleet` plugin's accounts, because a second copy of "which
 * boxes are there and where are their keys" is a second copy that goes out of
 * step. The lock itself is not a plugin at all — it is a password in a table
 * with no vendor behind it.
 *
 * TWO CONFIG KEYS, BOTH OF WHICH RUN A COMMAND ON A REAL MACHINE, and that is
 * why they are settings rather than a lookup table in code. See workstation.ts.
 *
 * THE ONE COLLECTOR IS THE WORKSTATION'S, and it is the only collector on this
 * box for which "the thing did not answer" is a SUCCESS: a desk machine is
 * expected to be off. Snapshots are not collected — an instant taken on a
 * schedule is a trend, badly — and screenshot QA is a run rather than a
 * collection, because it is minutes of the owner's attention rather than a
 * figure that goes stale on a cadence.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { serviceKey } from "../../auth.ts";
import { securityRoutes } from "./security-routes.ts";
import { snapshotRoutes } from "./snapshots-routes.ts";
import { startSnapshotTrigger } from "./snapshots.ts";
import { shotsqaRoutes } from "./shotsqa-routes.ts";
import { workstationRoutes } from "./workstation-routes.ts";
import {
  DOCUMENTED,
  PLUGIN as WORKSTATION,
  collectWorkstation,
  verify as verifyWorkstation,
} from "./workstation.ts";
import { SKILLS, PACKS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "security",

  plugins: {
    /*
      ONE ACCOUNT IS ONE MACHINE and the account's own label is its name — the
      same rule `fleet` keeps, for the same reason: the accounts route already
      takes a label, and a second name in the vault is a name that can disagree
      with the one on the page.

      THREE OF THE FOUR FIELDS ARE OPTIONAL, and each absence removes exactly
      one capability rather than breaking the account. No key: ssh uses this
      machine's own agent and ~/.ssh defaults. No MAC: everything works except
      wake, and `verify` then refuses a machine it cannot reach, because at that
      point nothing about the account could ever work. No broadcast: the limited
      broadcast, which cannot be routed off the local segment.
    */
    [WORKSTATION]: {
      secret: "workstation",
      fields: ["host", "key", "mac", "broadcast"],
      optional: ["key", "mac", "broadcast"],
      verify: verifyWorkstation,
    },
  },

  config: {
    [WORKSTATION]: {
      keys: {
        sleep: {
          label: "Sleep command",
          hint:
            "The command that suspends your machine, run over ssh as the account's user. EMPTY MEANS NOTHING " +
            "RUNS — there is no per-OS fallback here on purpose, because whether suspending needs sudo depends on " +
            `your own machine's policy. The documented ones are ${Object.entries(DOCUMENTED)
              .map(([os, c]) => `${os}: “${c.sleep}”`)
              .join(", ")}. Try it in your own terminal first.`,
          ph: "systemctl suspend",
          check(value) {
            const v = value.trim();
            if (!v) return null;
            if (v.includes("\n")) return "One command on one line. A script belongs on the machine, not in a settings box.";
            if (v.length > 200) return "That is longer than 200 characters, which is longer than a suspend command.";
            return null;
          },
        },
        shutdown: {
          label: "Shutdown command",
          hint:
            "The command that powers the machine off. EMPTY MEANS NOTHING RUNS. Note that shutting a machine down " +
            "is the one action here you cannot undo remotely: waking it needs wake-on-LAN, and a machine at S5 " +
            `answers a magic packet only if its firmware is set to. The documented ones are ${Object.entries(DOCUMENTED)
              .map(([os, c]) => `${os}: “${c.shutdown}”`)
              .join(", ")}.`,
          ph: "sudo systemctl poweroff",
          check(value) {
            const v = value.trim();
            if (!v) return null;
            if (v.includes("\n")) return "One command on one line.";
            if (v.length > 200) return "That is longer than 200 characters, which is longer than a shutdown command.";
            return null;
          },
        },
      },
    },
  },

  collectors: {
    [WORKSTATION]: collectWorkstation,
  },

  skills: SKILLS,
  packs: PACKS,

  routes: [
    { path: "/api/security", app: securityRoutes },
    { path: "/api/snapshots", app: snapshotRoutes },
    { path: "/api/shotsqa", app: shotsqaRoutes },
    { path: "/api/workstation", app: workstationRoutes },
  ],

  /**
   * Two things at boot.
   *
   * THE SERVICE KEY IS MINTED FIRST AND UNCONDITIONALLY. It has to exist before
   * anything reads it, and the two things that read it are a two-line shell
   * wrapper (`$(cat …)`) and an MCP subprocess's environment — neither of which
   * can create it. Minting it costs 32 random bytes and one 0600 file, on a box
   * that may never set a password at all; the alternative is a wrapper that
   * exports an empty string on the day the owner turns the lock.
   *
   * THE SNAPSHOT TRIGGER ARMS A TIMER AND NOTHING ELSE. It does nothing on a
   * box with no fleet accounts, nothing with no uptime list, and nothing when a
   * failing host is not linked to a box — see snapshots.ts on why the link is
   * the owner's own rather than a hostname match.
   */
  onStart() {
    serviceKey();
    startSnapshotTrigger();
  },
};
