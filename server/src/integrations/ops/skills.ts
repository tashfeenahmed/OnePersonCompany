/**
 * The ops area's skill entries.
 *
 * Types only from skills/registry.ts: a value-level import would cycle.
 *
 * THREE ENTRIES AND NOT FOUR. Backups have no skill and will not get one:
 * nothing about them is a fact about the business, so there is nothing for an
 * agent to quote, and the only interesting thing an agent could DO with them
 * is restore one — which is a decision made by a person with a shell, not by a
 * chat message. See integrations/ops/backups-routes.ts.
 *
 * NONE OF THEM HAS AN ACTION. Every write this area could offer is either
 * destructive (restore) or a remote shell (a fleet counter with a command in
 * it), and the registry's own header draws that line: an entry with no
 * `actions` cannot be made to write by any request the proxy will accept.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "uptime",
    title: "Uptime — are the sites answering, and how fast",
    plugins: ["uptime"],
    about:
      "Every host the owner listed, checked from THIS machine on every " +
      "collection: whether it answered under 400, how long the whole exchange " +
      "took including redirects and TLS, how many days its certificate has " +
      "left, and where the redirects landed. Availability, latency percentiles " +
      "and incidents are computed on every read over a window in hours, " +
      "default 24.",
    rules: [
      "Availability is the share of THIS BOX'S CHECKS that succeeded — roughly " +
        "one every thirty minutes, from a laptop on a domestic line. An outage " +
        "shorter than the gap between checks is invisible here, and hours when " +
        "this machine was asleep are hours nobody asked. Quote `checks` beside " +
        "any percentage, and never quote one where `enough` is false.",
      "A host that answered 403 or 500 is DOWN by this document's definition. " +
        "Say which status it was: “Cloudflare is challenging the checker” and " +
        "“the server is off” are both down and are not the same problem.",
      "Latency percentiles are over SUCCESSFUL checks only, and they are wall " +
        "clock for the whole exchange — not a ping and not time-to-first-byte. " +
        "They are a trend, not a service level.",
      "`tls.daysLeft: null` means the certificate was not read — a plain-http " +
        "target, or a handshake that did not complete. It never means expired, " +
        "and it is never zero days left.",
      "`redirectsToHttps` is null for any host typed without an explicit " +
        "http:// scheme, because the question was not asked. Null is not “no”.",
      "An incident with `ongoing: true` has not ended; its `end` is null. " +
        "`end` is the first check that SUCCEEDED again, which is the earliest " +
        "moment this box can honestly say the site was back.",
    ],
    views: [
      {
        key: "default",
        path: "/api/uptime",
        about:
          "Per host: the last check, availability over the window and over 24h and 7d, latency p50/p95, TLS days, and incidents.",
        params: [
          {
            name: "hours",
            type: "number",
            required: false,
            fallback: 24,
            about: "The window for availability, percentiles and incidents. Clamped to 1–720.",
          },
        ],
      },
      {
        key: "entities",
        path: "/api/uptime/entities",
        about: "The hosts as linkable entities, for the venture map.",
        params: [],
      },
    ],
    asks: [
      "Is anything down right now, and how long has it been?",
      "Which certificate expires next?",
    ],
  },

  {
    id: "fleet",
    title: "Fleet — what the boxes are doing, from inside them",
    plugins: ["fleet"],
    about:
      "One account is one machine, reached over ssh on every collection by a " +
      "single POSIX sh probe: load, cores, memory and swap in bytes, every " +
      "filesystem from df, docker containers where docker exists, and the " +
      "owner's own counter commands. Thirty days of samples. This is INSIDE " +
      "the guest, which is why it has memory and disk figures that " +
      "/api/hetzner structurally cannot have.",
    rules: [
      "LOAD IS NEVER ADDED OR AVERAGED ACROSS BOXES. It is already relative to " +
        "a machine's cores — 4.0 is idle on sixteen and a fire on one — so " +
        "`totals.load.combined` is null on purpose. Use `loadPerCpu` per box, " +
        "or `boxesOverOnePerCpu`.",
      "Memory and disk DO add across boxes, and those totals are real.",
      "Memory used is total minus AVAILABLE, not minus free. Linux's page cache " +
        "is not memory anybody is short of.",
      "Disk percentages are used / (used + available), which is what `df` " +
        "reports as Capacity. used / size would call a 62%-full Mac volume 2% " +
        "full, because an APFS container shares free space between volumes.",
      "`docker: null` means the probe never reached the box. `installed: false` " +
        "means docker is not there, which is different from zero containers " +
        "running.",
      "A counter with no reading has no reading. It is not zero: the command " +
        "may have failed, printed no number, or never run on that box. The " +
        "`note` says so.",
      "Every figure is from the last successful probe of THAT box. A box with " +
        "an `error` and an old `okAt` is showing history, not the present.",
      "There is no way to run a command on a box from here, and there will not " +
        "be. Counters are typed by the owner into a settings field; that is the " +
        "line, and asking for a shell is asking for something this API does not " +
        "have.",
    ],
    views: [
      {
        key: "default",
        path: "/api/fleet",
        about:
          "Per box: the latest sample, memory and disk meters with thresholds, load per cpu, containers, uptime and counters.",
        params: [
          {
            name: "hours",
            type: "number",
            required: false,
            fallback: 24,
            about: "How far back the samples and counter series go. Clamped to 1–720.",
          },
        ],
      },
      {
        key: "counters",
        path: "/api/fleet/counters",
        about:
          "The owner's own measurements, cut by counter rather than by box — the same number across every machine that could answer it.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 7,
            about: "How much counter history to return. Clamped to 1–30.",
          },
        ],
      },
      {
        key: "entities",
        path: "/api/fleet/entities",
        about: "The boxes as linkable entities, for the venture map.",
        params: [],
      },
    ],
    asks: [
      "Which box is running out of disk?",
      "Was anything swapping last night?",
    ],
  },

  {
    id: "products",
    title: "Product endpoints — the numbers only the products know",
    plugins: ["product-stats"],
    about:
      "JSON endpoints the owner's own products publish, one account per " +
      "endpoint, with a hand-written mapping of which numbers in the document " +
      "matter. Each mapped figure carries a value resolved from the last " +
      "document AND a recorded history from the collector. Windows are in " +
      "days and default to 30.",
    rules: [
      "A PATH THAT RESOLVES TO NOTHING IS A MAPPING ERROR, NEVER A ZERO. " +
        "`{\"reels\": 0}` and an endpoint with no `reels` field are different " +
        "facts about the business. Such metrics have a null value, an `error` " +
        "saying what the document does contain, and an entry in " +
        "`mappingErrors`.",
      "`value` is resolved from the LAST DOCUMENT on every read; `series` is " +
        "what the collector recorded at the time. A metric mapped this morning " +
        "has a value and almost no series, and that is honest rather than " +
        "broken.",
      "NOTHING IS EVER ADDED ACROSS ENDPOINTS. Two products' “renders” share a " +
        "word the owner chose and nothing else. `summary.combined` is null.",
      "The mapping is a setting the owner maintains. A number that is not on " +
        "the page is missing because nobody mapped it, not because the product " +
        "does not have it.",
      "`reachable: null` means the endpoint has never been collected — not " +
        "that it is down. A failing endpoint keeps its last good document, " +
        "dated, beside the reason it went quiet.",
    ],
    views: [
      {
        key: "default",
        path: "/api/products",
        about:
          "Per endpoint: reachable, when it was last fetched, every mapped metric with its current value and daily history, and the mapping errors.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 30,
            about: "How much recorded history each metric returns. Clamped to 1–400.",
          },
        ],
      },
      {
        key: "entities",
        path: "/api/products/entities",
        about: "The endpoints as linkable entities, for the venture map.",
        params: [],
      },
    ],
    asks: [
      "How many reels were rendered this week?",
      "Is any product endpoint failing, or is any mapping broken?",
    ],
  },
];

/** Where these land in Hermes' skill directory. Filed by subject, like every
 *  other pack — see skills/hermes.ts on why the categories are not vendors. */
export const PACKS: Record<string, { name: string; category: string }> = {
  uptime: { name: "uptime-checks", category: "infrastructure" },
  fleet: { name: "server-fleet", category: "infrastructure" },
  products: { name: "product-endpoints", category: "development" },
};
