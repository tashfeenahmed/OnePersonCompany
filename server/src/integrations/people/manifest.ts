/**
 * PEOPLE — the correspondence side of the mailbox, and the promises inside it.
 *
 * NO CREDENTIAL OF ITS OWN, DELIBERATELY. The credential is Gmail's, already
 * in the vault, already verified, already refreshed by providers/gmail.ts. A
 * second copy of a Google client id and refresh token so that this area could
 * "own" one would be a second thing to rotate and a second thing to leak.
 *
 * SO WHAT IS `people` AS A PLUGIN ID? Five settings and a collector, hanging
 * off a foreign key — the shape `backups` uses, one step further. It holds no
 * secret and connects to nothing; "connected" means THERE IS A MAILBOX TO
 * READ, derived from the Gmail accounts on every collection and every few
 * minutes by the timer below, because a collector that only ran after somebody
 * pressed Save would never run at all on an install where the defaults are
 * already right.
 *
 * WHY THE COLLECTOR IS NOT REGISTERED UNDER `gmail`. The collectors map is one
 * object keyed by plugin id; an entry under `gmail` would REPLACE the mail
 * collector rather than run beside it, and the inbox figures would quietly
 * stop. Two ids, two run ledgers, two failure states — the same reason Gmail
 * and Resend are two collectors rather than one.
 *
 * THE COMMITMENTS SCAN IS NOT A COLLECTOR AT ALL. It reads message BODIES, and
 * that is the one thing in this area which would be a surprise if it happened
 * every half hour because a scheduler exists. It happens when the owner presses
 * the button or asks the agent.
 */
import type { IntegrationManifest } from "../manifest.ts";
import {
  DEFAULT_MAX_RECEIVED,
  DEFAULT_MIN_EACH_WAY,
  DEFAULT_STALE_DAYS,
  DEFAULT_WINDOW_DAYS,
  MAX_SENT,
  PLUGIN,
  collectPeople,
  parseDomains,
  syncConnected,
} from "./contacts.ts";
import { startWeekly } from "./brief.ts";
import { startWatchSweep } from "./activity.ts";
import { peopleRoutes } from "./routes.ts";
import { commitmentRoutes } from "./commitments-routes.ts";
import { SKILLS, PACKS } from "./skills.ts";

const wholeNumber = (lo: number, hi: number, what: string) => (value: string) => {
  if (!value.trim()) return null;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < lo || n > hi)
    return `${what} — a whole number between ${lo} and ${hi}.`;
  return null;
};

export const manifest: IntegrationManifest = {
  id: "people",

  config: {
    [PLUGIN]: {
      keys: {
        "window-days": {
          label: "Window",
          hint:
            `How far back the contacts scan reads, in days. Default ` +
            `${DEFAULT_WINDOW_DAYS}. This is the window EVERY count on the ` +
            `page is over, and it is a rolling one: somebody who falls out the ` +
            `back of it leaves the list. A wider window is a better answer to ` +
            `“who do I know” and a slower collection — the scan reads one ` +
            `request per message, so a year of a busy mailbox is a couple of ` +
            `minutes.`,
          ph: String(DEFAULT_WINDOW_DAYS),
          check: wholeNumber(7, 1825, "That is not a window this can read"),
        },
        "min-each-way": {
          label: "Minimum messages each way",
          hint:
            `How many messages must have passed in BOTH directions before ` +
            `somebody counts as a correspondence rather than a transaction. ` +
            `Default ${DEFAULT_MIN_EACH_WAY} — the smallest number that ` +
            `cannot be produced by a single order, one question and one thank ` +
            `you. Everything scanned is still stored; this decides what the ` +
            `list shows and who gets a day chart.`,
          ph: String(DEFAULT_MIN_EACH_WAY),
          check: wholeNumber(1, 20, "That is not a threshold this can use"),
        },
        "self-domains": {
          label: "Your own domains",
          hint:
            "Domains whose people are you rather than your contacts, " +
            "separated by commas or newlines — your company domains, your " +
            "aliases. Every connected mailbox's own address is already " +
            "excluded; this is for the rest. GET THIS RIGHT OR THE LIST IS " +
            "WRONG IN THE MOST CONFUSING WAY: with two of your own addresses " +
            "left in, you arrive at the top of your own contacts with a " +
            "perfect two-way cadence. The approximation it costs is stated on " +
            "the page — a genuine outsider at one of these domains is dropped.",
          ph: "acme.io, mycompany.com",
          check(value) {
            const bad = (value.match(/\S+/g) ?? []).filter(
              (t) => !parseDomains(t).length && t !== "," && !t.endsWith(","),
            );
            if (bad.length)
              return `Not domains: ${bad.slice(0, 3).join(", ")}. A domain has a dot in it — acme.io, not acme.`;
            return null;
          },
        },
        "max-received": {
          label: "Received messages to scan",
          hint:
            `The cap on the INBOUND half of the scan. Default ` +
            `${DEFAULT_MAX_RECEIVED}. Gmail lists newest first, so a cap that ` +
            `bites keeps the most RECENT part of the window — “last heard ` +
            `from” stays true and the counts become floors, which the page ` +
            `says. The outbound half has its own budget of ${MAX_SENT} and no ` +
            `setting: “who have I stopped writing to” is the question this ` +
            `page exists for, and a knob that could starve the sent scan would ` +
            `make every answer to it a statement about the budget.`,
          ph: String(DEFAULT_MAX_RECEIVED),
          check: wholeNumber(100, 20000, "That is not a message cap this can use"),
        },
        "stale-days": {
          label: "Stale after",
          hint:
            `Days with no mail EITHER WAY before a contact is marked stale. ` +
            `Default ${DEFAULT_STALE_DAYS}. This is the calendar question and ` +
            `it is deliberately not the same as “cold”: cold is measured ` +
            `against that pair's own rhythm, so somebody you write to every ` +
            `August is cold in October and not stale until the spring.`,
          ph: String(DEFAULT_STALE_DAYS),
          check: wholeNumber(7, 730, "That is not a staleness window this can use"),
        },
      },
      /* A settings save is also the moment to re-derive "connected": the owner
         has just been on the page and expects a Collect button that works. */
      after: () => syncConnected(),
    },
  },

  collectors: { [PLUGIN]: collectPeople },

  skills: SKILLS,
  packs: PACKS,

  routes: [
    { path: "/api/people", app: peopleRoutes },
    /* Its own path rather than /api/people/commitments: a promise is not a
       property of a contact — most have no contact row at all, because a
       one-off message to somebody never met is still a promise. */
    { path: "/api/commitments", app: commitmentRoutes },
  ],

  onStart() {
    /* Whether there is a mailbox is a fact about ANOTHER plugin's accounts, so
       nothing tells this one when it changes. Re-derived at boot and every ten
       minutes, which is well inside the half-hourly collection tick. */
    syncConnected();
    setInterval(() => syncConnected(), 10 * 60_000).unref();
    startWeekly();
    /*
      THE WATCHLIST'S PUBLIC HALF, AND IT IS THE ONE TIMER IN THIS AREA THAT
      NEEDS NO MAILBOX. It reads GitHub, Bluesky, Hacker News and RSS
      anonymously, so it runs on a box with no Gmail account connected at all —
      which is exactly the box where a watchlist is the only thing this area
      can offer. Twenty-hourly per person, checked hourly, two seconds apart,
      and every source failing into a sentence on the row rather than an
      exception here: see activity.ts.
    */
    startWatchSweep();
  },
};
