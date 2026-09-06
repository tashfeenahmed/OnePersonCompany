/**
 * THE `migrate` SKILL — what came across, and what an adapter is publishing.
 *
 * IT HAS NO ACTIONS AT ALL, and the absence is the design. Two of the three
 * things this area can do are things an agent must not initiate: an IMPORT
 * reads a directory off the filesystem and writes to every table in one
 * transaction, and a ROLLBACK deletes rows the owner may have edited since.
 * Both are irreversible in the way that matters — the first because it moves
 * somebody's whole history, the second because it removes it — and both take a
 * decision that belongs to the person who knows why they are migrating.
 *
 * So the agent can READ the ledger and explain it. That is genuinely useful:
 * "why is there no Stripe history on this box when I imported it" has a real
 * answer, it is one sentence per series, and it is sitting in migrate_history's
 * `reason` column waiting for somebody to ask.
 *
 * THE THIRD THING — validating a sample payload — is a POST and is still not
 * published, because the payload is a product's real user list including its
 * addresses, and a tool that took one as a parameter would be a tool that could
 * be asked to paste four thousand addresses into a chat transcript.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "migrate",
    title: "Migration — imported batches, and what the adapters publish",
    plugins: [],
    about:
      "The ledger of imports from a predecessor dashboard, and the state of the product endpoints that publish the users and product-stats contracts. " +
      "`batches` is one row per run of the importer with what it created; `history` is the metric history that was imported as PROVENANCE ONLY, with the reason each series could not go into a live table; " +
      "`adapters` is every configured product endpoint with its last collection and its last validated sample, including the population breakdown. " +
      "Nothing here starts, repeats or reverses an import.",
    rules: [
      "NOTHING IN `history` IS A LIVE FIGURE. Those rows are in migrate_history, joined into no chart, and every one carries the sentence saying why it is not " +
        "in the table it names. Never quote one as this business's traffic, revenue or downloads — quote it as “the predecessor recorded X” and say the window.",
      "The `window` on a history row decides what it means and they are not interchangeable: `day` is one day's figure, `rolling` is a window ENDING that day " +
        "(so two consecutive rows overlap and must never be summed), `level` is a snapshot of a standing quantity, `cumulative` only rises and its differences " +
        "are the daily figures — but only across consecutive days, because a gap differenced is an invented day.",
      "A batch's `counts` is what the run reported and `created` is what its id map says is in the database now. After a rollback they disagree, and `created` " +
        "is the one that is true.",
      "On an adapter, a metric with a `why` is a MAPPING ERROR and never a zero: the path matches nothing in the document that endpoint actually returns. " +
        "The difference between “the product published 0” and “nobody could find the number” is the whole reason this is not reported as a figure.",
      "`populations` counts what the users table holds. A product that never sends the `population` field counts entirely as `customer`, because that is the " +
        "documented default for the older contract — so “all customers” may mean “classified as customers” or may mean “not classified at all”, and the " +
        "adapter's last validation is what distinguishes them.",
      "`contactPermitted` is false unless a product's adapter was configured with an explicit consent mapping. A zero here means nobody has said anybody may " +
        "be written to, which is the default and is not evidence that consent does not exist somewhere else. Never treat this count as a list: there is no " +
        "route on this box that returns an address, and addresses are stored as a salted hash.",
      "`dryRun: true` on a batch means it wrote NOTHING. Its counts are a forecast of what a real run would have done at that moment, not a record of anything " +
        "that happened.",
    ],
    views: [
      {
        key: "batches",
        path: "/api/migrate/batches",
        about: "Every import run, newest first: what it read, what it created, what it skipped, its problems, and whether it can still be rolled back.",
        params: [],
      },
      {
        key: "batch",
        path: "/api/migrate/batches/:id",
        about:
          "One batch with its whole id map — every source record and the row it became, and whether this batch CREATED that row or only pointed at one that " +
          "was already here. Also the files it copied and a summary of the history it tagged.",
        params: [{ name: "id", type: "string", required: true, in: "path", about: "The batch id, like b-3k9x2p01." }],
      },
      {
        key: "history",
        path: "/api/migrate/history",
        about:
          "The imported metric history, grouped by series and subject, with each one's window, row count, date range and the reason it is provenance rather " +
          "than a live figure. `plan` is the same reasoning for every series the importer knows about, whether or not any rows arrived.",
        params: [
          { name: "source", type: "string", required: false, about: "One series name — revenue, traffic, search, playstore, appstore, users, ads… Absent means all of them." },
        ],
      },
      {
        key: "adapters",
        path: "/api/migrate/adapters",
        about:
          "Every configured product endpoint on both contracts, with its last collection, its last validated sample and — for a product-stats endpoint — which " +
          "mapped paths currently resolve in the document it answers with. Plus the population breakdown of the users table as it stands.",
        params: [],
      },
    ],
    asks: [
      "What did the WorkDash import actually bring across, and what did it skip?",
      "Why is there no Stripe history on this box when I imported it?",
      "Which of my product adapters have never been validated, and which ones have a mapping that resolves to nothing?",
    ],
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  migrate: { name: "migration", category: "productivity" },
};
