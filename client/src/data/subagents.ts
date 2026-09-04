/**
 * THE SUB-AGENTS - the standing workers, one per queue kind.
 *
 * Mirrors the roster in workdash's src/data/useSubagents.ts, which itself names
 * the `kind` strings agent/queue.js drains. The two lanes are a real difference
 * rather than a grouping: the eight ai: kinds share one lane and so run strictly
 * one at a time (there is one GPU), while the five media kinds are laneless -
 * one run per kind, kinds in parallel.
 *
 * History is as long as the server's memory: the queue keeps finished items for
 * 48 hours, so this is a window rather than a ledger.
 */

export type Lane = "ai" | "media";
export type RunOutcome = "done" | "failed" | "cancelled";

export type Subagent = {
  /** The queue's own discriminator. */
  kind: string;
  /** URL segment: short, stable, free of the colon the kind carries. */
  slug: string;
  name: string;
  /** Key into AGENT_GLYPHS. */
  icon: string;
  lane: Lane;
  /** One sentence: what this worker does when its turn comes. */
  what: string;
  /** The page its output lands on. */
  module: string;
  /** What the current or next run is for. */
  target: string;
  running: boolean;
  waiting: number;
  history: RunOutcome[];
  last: string;
};

export const LANES: Record<Lane, { name: string; rule: string; note: string }> =
  {
    ai: {
      name: "AI lane",
      rule: "one at a time",
      note: "These eight share a single lane in the queue, so a dossier, an SEO analysis and a competitor sweep queued together drain in series. There is one GPU, and the waiting is real.",
    },
    media: {
      name: "Media workers",
      rule: "one run per kind, kinds in parallel",
      note: "Laneless. Each of these can be working at the same time as the others, but never twice at once on itself.",
    },
  };

/** Line-art marks in the shell's own stroke language - these are workers,
 *  not brands, so no colour tiles. */
export const AGENT_GLYPHS: Record<string, string> = {
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  monitor:
    '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  shield:
    '<path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 9.5 4.1-1.9 7-5.3 7-9.5V6Z"/>',
  sprout:
    '<path d="M12 21v-8"/><path d="M12 13C8 13 6 10.5 6 7c3.5 0 6 2 6 6Z"/><path d="M12 13c4 0 6-2.5 6-6-3.5 0-6 2-6 6Z"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5"/>',
  power: '<path d="M12 3v9"/><path d="M6.5 7a8 8 0 1 0 11 0"/>',
  flame:
    '<path d="M12 3c4 4 6 6.5 6 10a6 6 0 0 1-12 0c0-2 1-3.5 2.5-5 .3 1.4 1 2.2 2 2.5C10 8 10.5 5.5 12 3Z"/>',
  megaphone:
    '<path d="m3 11 14-6v14L3 13Z"/><path d="M7 12.5V18a2 2 0 0 0 4 0v-4"/><path d="M20 10v4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  pencil:
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
};

export const SUBAGENTS: Subagent[] = [
  {
    kind: "ai:people",
    slug: "dossiers",
    name: "Dossiers",
    icon: "target",
    lane: "ai",
    what: "Pulls a watched person's public activity, then writes their dossier.",
    module: "People",
    target: "Ada Lovelace",
    running: true,
    waiting: 2,
    history: ["done", "done", "failed", "done", "done", "done"],
    last: "14m ago",
  },
  {
    kind: "ai:research",
    slug: "research",
    name: "Research",
    icon: "cpu",
    lane: "ai",
    what: "Investigates one of our own projects against the commercial web and writes the report.",
    module: "Research",
    target: "example-app-1",
    running: false,
    waiting: 1,
    history: ["done", "done", "done", "cancelled", "done"],
    last: "2h ago",
  },
  {
    kind: "ai:competitors",
    slug: "competitors",
    name: "Competitors",
    icon: "monitor",
    lane: "ai",
    what: "Sweeps a market's rivals — what they publish, price and rank for.",
    module: "Competitors",
    target: "AI video tools",
    running: false,
    waiting: 0,
    history: ["done", "done", "done", "done"],
    last: "9h ago",
  },
  {
    kind: "ai:seo",
    slug: "seo",
    name: "SEO",
    icon: "shield",
    lane: "ai",
    what: "Reads the crawl and Search Console, and says what to change.",
    module: "SEO",
    target: "example.ie",
    running: false,
    waiting: 0,
    history: ["done", "failed", "done", "done", "done", "done", "done"],
    last: "18h ago",
  },
  {
    kind: "ai:demand",
    slug: "demand",
    name: "Demand",
    icon: "sprout",
    lane: "ai",
    what: "Reads what strangers asked for across the mined sources, per project.",
    module: "Demand",
    target: "freellmapi",
    running: false,
    waiting: 1,
    history: ["done", "done", "done"],
    last: "yesterday",
  },
  {
    kind: "ai:geo",
    slug: "ai-visibility",
    name: "AI visibility",
    icon: "globe",
    lane: "ai",
    what: "Asks the models what they say about us, and scores where we stand.",
    module: "SEO",
    target: "the whole estate",
    running: false,
    waiting: 0,
    history: ["done", "done", "done", "done", "done"],
    last: "yesterday",
  },
  {
    kind: "ai:gardening",
    slug: "rounds",
    name: "The rounds",
    icon: "activity",
    lane: "ai",
    what: "Walks the whole estate, files what it finds as cards and notes.",
    module: "Workflows",
    target: "the whole estate",
    running: false,
    waiting: 0,
    history: ["done", "done", "done", "done", "done", "done", "done", "done"],
    last: "06:00",
  },
  {
    kind: "ai:academic",
    slug: "papers",
    name: "Papers",
    icon: "book",
    lane: "ai",
    what: "Reads the year's literature for a project and writes a paper into it.",
    module: "Academic",
    target: "example-app-4",
    running: false,
    waiting: 0,
    history: ["done", "done"],
    last: "3d ago",
  },
  {
    kind: "autopilot",
    slug: "autopilot",
    name: "Autopilot",
    icon: "power",
    lane: "media",
    what: "Works a run of projects end to end, making the videos each one is due.",
    module: "Studio",
    target: "4 projects due",
    running: true,
    waiting: 0,
    history: ["done", "done", "failed", "done"],
    last: "running",
  },
  {
    kind: "reel",
    slug: "reels",
    name: "Reels",
    icon: "flame",
    lane: "media",
    what: "Renders a Peter & Stewie reel from its script.",
    module: "Studio",
    target: "reel #218",
    running: true,
    waiting: 3,
    history: ["done", "done", "done", "done", "done"],
    last: "running",
  },
  {
    kind: "shorts",
    slug: "shorts",
    name: "Shorts",
    icon: "megaphone",
    lane: "media",
    what: "Cuts and renders the YouTube shorts in a batch.",
    module: "Studio",
    target: "batch of 6",
    running: false,
    waiting: 0,
    history: ["done", "done", "cancelled", "done"],
    last: "4h ago",
  },
  {
    kind: "faceless",
    slug: "faceless",
    name: "Faceless",
    icon: "copy",
    lane: "media",
    what: "Writes, voices and renders a batch of faceless videos.",
    module: "Studio",
    target: "batch of 3",
    running: false,
    waiting: 2,
    history: ["done", "failed", "done", "done"],
    last: "5h ago",
  },
  {
    kind: "motion",
    slug: "motion",
    name: "Motion",
    icon: "pencil",
    lane: "media",
    what: "Renders a motion-graphics clip from a prompt.",
    module: "Studio",
    target: "pricing explainer",
    running: false,
    waiting: 0,
    history: ["done", "done", "done"],
    last: "2d ago",
  },
];
