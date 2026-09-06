/**
 * OPS — what keeps running, and what it would take to get it back.
 *
 * Four things that are all one question asked at four depths. `uptime` asks it
 * from outside, the way a visitor does. `fleet` asks it from inside the
 * machine, over ssh. `product-stats` asks the product itself. And `backups`
 * is the answer to the version of the question nobody wants: what if the
 * machine is gone.
 *
 * TWO CREDENTIALED PLUGINS, TWO CONFIG-ONLY REGISTRIES, AND A PSEUDO-PLUGIN.
 * `uptime` needs no credential — an uptime check is a request any stranger
 * could make, which is exactly what makes it worth making — so "connected"
 * means what it means for npm: there is a list. `fleet` and `product-stats`
 * hold real credentials, one account per box and one per endpoint. `backups`
 * is not a plugin at all: it holds settings under a plugin id so it can use
 * the same closed, checked settings registry everything else uses, and it has
 * no collector, no accounts and no skill.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { upsertPlugin } from "../../db.ts";

import { collectUptime, parseHosts, validHost } from "./uptime.ts";
import { uptimeRoutes } from "./uptime-routes.ts";
import { checkCounters, collectFleet, verify as verifyFleet } from "./fleet.ts";
import { fleetRoutes } from "./fleet-routes.ts";
import {
  PLUGIN as PRODUCTS,
  checkMetrics,
  collectProducts,
  verify as verifyProduct,
} from "./products.ts";
import { productRoutes } from "./products-routes.ts";
import {
  DEFAULT_HOUR,
  DEFAULT_KEEP,
  PLUGIN as BACKUPS,
  afterConfig,
  startNightly,
} from "./backups.ts";
import { backupRoutes } from "./backups-routes.ts";
import { SKILLS, PACKS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "ops",

  plugins: {
    /*
      ONE ACCOUNT IS ONE BOX. The label is the box's name and is not a field
      here for that reason: the accounts route already takes one, and a second
      name in the vault would be a name that can disagree with the one on the
      page. The key is optional — with none, ssh uses the owner's own agent and
      ~/.ssh defaults, which is how a box already reachable from this machine's
      terminal is reachable from here with nothing pasted.
    */
    fleet: {
      secret: "fleet",
      fields: ["host", "key"],
      optional: ["key"],
      verify: verifyFleet,
    },

    /*
      ONE ACCOUNT IS ONE ENDPOINT, and the label is the product's name. The
      token is optional because most of these are public or carry their key in
      a URL the owner pasted; when there is one it goes out as a bearer.
    */
    [PRODUCTS]: {
      secret: "product",
      fields: ["url", "token"],
      optional: ["token"],
      verify: verifyProduct,
    },
  },

  config: {
    uptime: {
      keys: {
        hosts: {
          label: "Hosts",
          hint:
            "The addresses to check, one per line or separated by commas. A " +
            "bare name is asked over https, because that is what a browser " +
            "does. Type http:// in front of one to also check that it " +
            "redirects to https. Each is checked on every collection — about " +
            "every thirty minutes — from THIS machine, so what you get is a " +
            "trend from your own connection rather than a service level.",
          ph: "acme.com, acme.ie, http://acme.so",
          check(value) {
            const bad = parseHosts(value).filter((h) => !validHost(h));
            if (bad.length)
              return `Not addresses this can check: ${bad.slice(0, 3).join(", ")}. A hostname, or a full http(s) URL.`;
            if (parseHosts(value).length > 50)
              return "That is more than fifty hosts. Each one is a request — two, when a HEAD is refused — every half hour.";
            return null;
          },
        },
      },
      /* CONNECTED MEANS "THERE IS A LIST", npm's reading and for npm's reason:
         there are no accounts here to derive it from, and with no hosts the
         collector has nothing to ask about. */
      after(values) {
        upsertPlugin("uptime", parseHosts(values.hosts ?? "").length > 0, null);
      },
    },

    fleet: {
      keys: {
        counters: {
          label: "Counters",
          hint:
            "Your own measurements, one per line: “label = shell command”. " +
            "The value recorded is the first number the command prints, and " +
            "ONLY if it exits zero — a command that fails or prints no number " +
            "is a gap on the chart, never a nought. THE SAME LINES RUN ON " +
            "EVERY BOX, as the account's ssh user; on a machine where the " +
            "command makes no sense it fails and is reported as failed there. " +
            "This is the only place a command is ever sent to your servers: " +
            "no route and no agent action can name one.",
          ph: "queue depth = redis-cli llen jobs\ncontainers = docker ps -q | wc -l",
          check: checkCounters,
        },
      },
    },

    [PRODUCTS]: {
      keys: {
        metrics: {
          label: "Metrics",
          hint:
            "Which numbers in each endpoint's JSON matter, one per line: " +
            "“label = path.to.the.number”. Use [0] for an array index and " +
            "@count(path) for how many items a list has. A line applies to " +
            "every endpoint unless you prefix it with an endpoint's label and " +
            "a colon. A path that matches nothing is reported as a mapping " +
            "error with the keys the document actually has — it is never " +
            "recorded as zero.",
          ph: "renders today = stats.today.renders\nopen jobs = @count(queue.jobs)\nAcme: applications = index.count",
          check: checkMetrics,
        },
      },
    },

    /*
      BACKUPS ARE SETTINGS AND NOT A PLUGIN. There is no credential, no
      account and no collector; what there is is four decisions and a switch,
      and they belong in the one registry that checks a value before storing it
      rather than in a file nobody can correct from the page.
    */
    [BACKUPS]: {
      keys: {
        nightly: {
          label: "Nightly backup",
          hint:
            "“on” or “off”. OFF UNTIL YOU TURN IT ON, deliberately: this " +
            "writes an archive containing vault.key in plaintext, and a " +
            "process that started doing that at four in the morning because a " +
            "default said so would be a surprise. Nothing else here has to be " +
            "set — the defaults are real.",
          ph: "off",
          check(value) {
            const v = value.trim().toLowerCase();
            return !v || v === "on" || v === "off" ? null : "Either “on” or “off”.";
          },
        },
        dir: {
          label: "Backup directory",
          hint:
            "Where archives are written. Defaults to a `backups` folder inside " +
            "the data directory, which is on the same disk as the thing being " +
            "backed up — fine against a mistake, useless against a dead drive. " +
            "Point it at another volume, or set a remote below.",
          ph: "/Volumes/Backup/opc",
          check(value) {
            if (!value.trim()) return null;
            if (!value.trim().startsWith("/"))
              return "An absolute path, please — a relative one would mean something different depending on where the server was started from.";
            return null;
          },
        },
        remote: {
          label: "Copy to (rsync over ssh)",
          hint:
            "Optional. `user@host:/path` — each archive is rsync'd there after " +
            "it is written. Add ` key=<label>` to use the ssh key of one of " +
            "your fleet boxes instead of this machine's own. REMEMBER WHAT IS " +
            "IN THE FILE: vault.key in plaintext, which is every credential on " +
            "this box. A failed copy does not fail the backup — the local " +
            "archive is still a real backup and the page says the copy did not " +
            "leave.",
          ph: "backup@nas.local:/volume1/opc key=NAS",
          check(value) {
            const v = value.trim();
            if (!v) return null;
            const target = v.replace(/\s+key=.+$/, "").trim();
            if (!/^[a-z0-9_][a-z0-9._-]*@[a-z0-9.-]+:.+$/i.test(target))
              return `“${target}” is not an rsync target. It is user@host:/path, optionally followed by key=<fleet account label>.`;
            return null;
          },
        },
        keep: {
          label: "Archives to keep",
          hint:
            `How many archives stay in the directory; older ones are deleted ` +
            `after a new one is written, never before. Default ${DEFAULT_KEEP}. ` +
            `Only this app's own opc-*.tar.gz files are ever pruned.`,
          ph: String(DEFAULT_KEEP),
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            if (!Number.isInteger(n) || n < 1 || n > 365)
              return "A whole number of archives to keep, between 1 and 365.";
            return null;
          },
        },
        hour: {
          label: "Hour of the nightly run",
          hint:
            `The local hour, 0–23. Default ${DEFAULT_HOUR}. The timer checks ` +
            `every ten minutes rather than sleeping until the hour, so a ` +
            `laptop that was shut at four runs the backup when it wakes ` +
            `instead of skipping the night.`,
          ph: String(DEFAULT_HOUR),
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            if (!Number.isInteger(n) || n < 0 || n > 23)
              return "An hour of the day, 0 to 23, in this machine's own time zone.";
            return null;
          },
        },
      },
      after: afterConfig,
    },
  },

  collectors: {
    uptime: collectUptime,
    fleet: collectFleet,
    [PRODUCTS]: collectProducts,
  },

  skills: SKILLS,
  packs: PACKS,

  routes: [
    { path: "/api/uptime", app: uptimeRoutes },
    { path: "/api/fleet", app: fleetRoutes },
    /* The route is /api/products and the plugin is `product-stats`: the route
       names the thing measured, the plugin names the integration that measures
       it. The skill is `products`, with the route. */
    { path: "/api/products", app: productRoutes },
    { path: "/api/backups", app: backupRoutes },
  ],

  /* The only timer this area owns. It arms nothing on its own: `startNightly`
     wakes every ten minutes and does nothing at all until the owner has
     switched the setting on. */
  onStart: startNightly,
};
