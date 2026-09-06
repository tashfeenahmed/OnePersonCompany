/**
 * THE SKILL PACKS — the registry, rendered into the only format Hermes reads.
 *
 * A Hermes skill is a directory holding a SKILL.md: YAML frontmatter the agent
 * sees in its system prompt as one line (name + description), and a body it
 * loads on demand with `skill_view(name)`. That two-stage shape is why this is
 * worth doing at all: nineteen integrations' worth of honesty rules will not
 * fit in a system prompt, but nineteen one-line descriptions will, and the
 * agent pulls the rules for the one it needs at the moment it needs them.
 *
 * WHY GENERATE THEM RATHER THAN WRITE THEM BY HAND. They have to match what is
 * connected. A pack for App Store Connect on a box with no App Store credential
 * is an invitation for the agent to report a revenue of zero for an integration
 * nobody set up, which is the single worst failure this feature can have — it
 * looks exactly like an answer. So the set is regenerated from the registry
 * whenever the connected set changes, and a pack whose plugin has gone is
 * DELETED rather than left to rot.
 *
 * A FEW OF THEM NOW SAY HOW TO CHANGE SOMETHING, and where they do it is a
 * section of its own called "Acting on it" — never a line folded into the
 * reading instructions. The agent reads this file in one pass and then does
 * something, so a `curl -X POST` sitting in a paragraph about how to fetch a
 * figure is a write it can make while it believes it is looking something up.
 * A heading is what makes the two halves distinguishable at the speed a model
 * reads. The frontmatter's one line names the actions too, for a blunter
 * reason: that line is all the agent sees until it decides to open the pack,
 * and an agent asked to add a card that has not been told the board can be
 * written to will explain that it cannot.
 *
 * WHY THE PACKS ARE FILED BY SUBJECT, NOT BY VENDOR.
 *
 * They were one category called `opc` with an `opc-` prefix on every name,
 * which made them enumerable — and made them a bundle. See PLACEMENT below for
 * the layout that replaced it and the reasoning; the marker file is what keeps
 * pruning safe now that our packs sit beside everyone else's.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNIVERSAL_RULES, skills, type Skill, type SkillParam } from "./registry.ts";
import { manifestPacks } from "../integrations/index.ts";
import { PRESENT_GUIDE } from "./present.ts";

/** The category directory these all live in, under `$HERMES_HOME/skills/`. One
 *  of its own so the agent's index groups them, and so the prune below has a
 *  directory it can be certain nothing else writes into. */
/**
 * WHERE EACH PACK LIVES, AND WHAT IT IS CALLED.
 *
 * The first cut filed all eighteen under one category, `opc`, with a category
 * description that began "This one-person company's own live data…" — and the
 * model did exactly what that layout invited: asked what skills it had, it
 * answered "the One Person Company skills" as one bundle. Hermes renders the
 * index BY CATEGORY, category line first; a vendor-shaped category with a
 * vendor-shaped sentence over it is a bundle by construction, whatever the
 * eighteen lines under it say.
 *
 * So each pack is filed where a person would look for it — finance, infra,
 * marketing — beside Hermes' own skills, with a name that says what it reads
 * rather than who generated it. Nothing in the frontmatter names this app: the
 * agent should know it has a Stripe skill, not that it has a dashboard.
 *
 * `github` keeps a suffix because Hermes ships a bundled skill of that name and
 * a clash makes `_locate_skill` refuse both. Everything else is plain.
 */
const BUILTIN_PLACEMENT: Record<string, { name: string; category: string }> = {
  stripe: { name: "stripe-revenue", category: "finance" },
  costs: { name: "llm-spend", category: "finance" },
  mobile: { name: "app-store-revenue", category: "finance" },
  adsense: { name: "adsense-earnings", category: "finance" },
  hetzner: { name: "hetzner-fleet", category: "infrastructure" },
  cloudflare: { name: "cloudflare-traffic", category: "infrastructure" },
  domains: { name: "domain-portfolio", category: "infrastructure" },
  gsc: { name: "search-console", category: "marketing" },
  bing: { name: "bing-webmaster", category: "marketing" },
  meta: { name: "meta-ads", category: "marketing" },
  demand: { name: "demand-signals", category: "marketing" },
  github: { name: "github-traffic", category: "development" },
  npm: { name: "npm-downloads", category: "development" },
  mail: { name: "mailbox-stats", category: "communication" },
  /* `mailbox` beside `mailbox-stats`, which is the point: one counts and one
     reads, they answer different questions, and the pair being adjacent in the
     index is how the agent notices there is a choice to make. */
  mailbox: { name: "mailbox", category: "communication" },
  telegram: { name: "telegram-bridge", category: "communication" },
  board: { name: "kanban-board", category: "productivity" },
  ventures: { name: "ventures", category: "productivity" },
  stock: { name: "stock-media-quota", category: "media" },
  search: { name: "web-search", category: "research" },
};

/* Built-ins, then each integration area's packs — see integrations/manifest.ts. */
const PLACEMENT: Record<string, { name: string; category: string }> = {
  ...manifestPacks(),
  ...BUILTIN_PLACEMENT,
};

/** The pack name for a skill — the table above, or the id when it is not
 *  listed (a new registry entry lands as itself rather than failing). */
export function packName(id: string): string {
  return PLACEMENT[id]?.name ?? id;
}
function packCategory(id: string): string {
  return PLACEMENT[id]?.category ?? "general";
}

/** A file only this app's packs carry, so pruning can find what it wrote
 *  without a name prefix and without ever touching a pack somebody else made. */
const MARKER = ".opc-generated";

/** The legacy layout, removed on first sync so the bundle cannot linger. */
const LEGACY_CATEGORY = "opc";

/* ---------------------------------------------------------------- rendering */

/** YAML for a string that may contain a colon, a quote or a newline. JSON is
 *  valid YAML for scalars, which is the whole trick and avoids an escaping
 *  routine this file would then own. */
const y = (v: string) => JSON.stringify(v);

function frontmatter(s: Skill): string {
  /* Deduped, because a skill whose id IS its plugin id (stripe, github, meta)
     would otherwise carry the same tag twice and look like a generation bug in
     a file a person will read. */
  const tags = [...new Set([s.id, ...s.plugins])];
  return [
    "---",
    `name: ${packName(s.id)}`,
    /* The ONE line the agent sees before it decides to load anything, so it
       has to say what the data is and not merely name it — and, where the skill
       can write, that it can, with the action names. An agent asked to move a
       card does not open a pack whose one line only offers to read. */
    `description: ${y(
      `${s.title}. Read it live with the \`opc ${s.id}\` command in the terminal, ` +
        `with the rules for reporting the figures honestly.` +
        (s.actions?.length
          ? ` It can also change it — ${s.actions.map((a) => a.key).join(", ")} — ` +
            `under the rules the pack sets out.`
          : ""),
    )}`,
    "version: 1.0.0",
    "license: MIT",
    "platforms: [linux, macos, windows]",
    "metadata:",
    "  hermes:",
    `    tags: [${tags.join(", ")}]`,
    /* No related_skills list. Eighteen packs each naming the other seventeen is
       the second way to say "these are one bundle", and the index already puts
       the finance ones beside each other. */
    "---",
  ].join("\n");
}

/** A flag's example value: a number stays a number, a string is its default
 *  when it has one and a placeholder when it does not. */
function exampleFlag(p: SkillParam): string {
  if (p.type === "number") return `--${p.name} ${p.fallback ?? 1}`;
  return `--${p.name} ${p.fallback !== undefined ? JSON.stringify(String(p.fallback)) : '"…"'}`;
}

function body(s: Skill, cli: string | null): string {
  const out: string[] = [];

  out.push(`\n# ${s.title}\n`);
  out.push("## When to use\n");
  out.push(
    `Use this whenever the owner asks about ${s.id} — for example: ` +
      `${s.asks.map((q) => `"${q}"`).join(" or ")}. ` +
      `The answer is a live figure from this machine's own database; never ` +
      `estimate one and never answer from memory.\n`,
  );

  out.push("## What the data is\n");
  out.push(`${s.about}\n`);

  /*
    THE COMMAND, NOT A URL. `opc` is on the terminal's PATH — see skills/cli.ts —
    and it is the only way this pack says to read anything. It forwards to the
    dashboard's own proxy, passes the document back verbatim, refuses a flag
    the skill does not have, and tells the read from the write by the catalog
    rather than by what the agent believed it was doing.
  */
  out.push("## How to read it\n");
  s.views.forEach((v, i) => {
    const flags = v.params.map(exampleFlag).join(" ");
    const cmd = `opc ${s.id}${i === 0 ? "" : ` ${v.key}`}${flags ? ` ${flags}` : ""}`;
    out.push(`**${v.about}**\n`);
    out.push("```bash");
    out.push(cmd);
    out.push("```\n");
    if (v.params.length) {
      out.push("| flag | default | what it means |");
      out.push("| --- | --- | --- |");
      for (const p of v.params)
        out.push(
          `| \`--${p.name}\` | ${p.required ? "**required**" : `\`${p.fallback ?? "—"}\``} | ${p.about} |`,
        );
      out.push("");
    }
  });
  const actions = s.actions ?? [];
  out.push(
    `Reading changes nothing at all. ` +
      (actions.length
        ? `Changing something is the next section, and there is no other way to ` +
          `write here — no other command and no URL. `
        : `This skill has nothing that writes: there is no other command here. `) +
      `The document is JSON on stdout — pipe it through \`jq\` if it is long. ` +
      `\`opc help ${s.id}\` prints this pack's commands, flags and rules again; ` +
      `\`opc\` alone lists every skill this dashboard has, including the ones ` +
      `that are NOT connected, which is the answer to give when a figure is missing.` +
      (cli ? ` If the shell cannot find \`opc\`, it is \`${cli}\`.` : "") +
      `\n`,
  );

  /*
    THE WRITES, UNDER A HEADING OF THEIR OWN. Every one is `opc <id> <action>`
    with its parameters as flags — a number as a bare number, a string quoted —
    and the reply is the whole document as it now stands.
  */
  if (actions.length) {
    out.push("## Acting on it\n");
    out.push(
      `These CHANGE the owner's own data. Each is \`opc ${s.id} <action>\` with ` +
        `every parameter as a \`--flag value\`; the reply is the whole document as ` +
        `it now stands, so read what you changed back out of it and tell him what ` +
        `you did. Do none of these unless he asked for that exact change.\n`,
    );
    for (const a of actions) {
      const flags = a.params.filter((p) => p.required || p.exampled).map(exampleFlag).join(" ");
      out.push(`**${a.about}**${a.destructive ? " **There is no undo.**" : ""}\n`);
      out.push("```bash");
      out.push(`opc ${s.id} ${a.key}${flags ? ` ${flags}` : ""}`);
      out.push("```\n");
      if (a.params.length) {
        out.push("| flag | required | what it means |");
        out.push("| --- | --- | --- |");
        for (const p of a.params)
          out.push(
            `| \`--${p.name}\` | ${p.required ? "**yes**" : `no${p.fallback !== undefined ? ` (default \`${p.fallback}\`)` : ""}`} | ${p.about} |`,
          );
        out.push("");
      }
    }
  }

  /* THE PART THAT IS THE POINT. It is last rather than first because the agent
     reads the whole file, and last is what it has most recently seen when it
     comes to write the answer. */
  out.push("## Reporting it honestly — these are not optional\n");
  for (const r of s.rules) out.push(`- ${r}`);
  out.push("");
  out.push("And the rules every document on this dashboard keeps:\n");
  for (const r of UNIVERSAL_RULES) out.push(`- ${r}`);
  out.push("");
  out.push(
    "If the document does not carry the figure you were asked for, say so and " +
      "say what it does carry. A number invented to fill a gap is worse than the " +
      "gap: the owner cannot tell them apart, and he makes decisions on these.\n",
  );

  return out.join("\n");
}

/** One SKILL.md, whole. Written whole rather than patched, for the reason
 *  configureHermes writes its config.yaml whole: this app owns the file, and a
 *  surgical edit of a generated document is a merge with a version of itself. */
function render(s: Skill, cli: string | null): string {
  return `${frontmatter(s)}${body(s, cli)}`;
}

/*
  THE ONE PACK THAT IS NOT A SKILL. `rich-answers` says how to draw figures in
  the chat — cards, charts, bars, meters, tables — and it is always present,
  because there is no plugin whose absence would make a chart wrong. It is
  filed under communication, beside the mailbox, which is where "how do I say
  this" lives. Its body is present.ts's guide verbatim, which is also what
  `opc present` prints and what a remote agent gets in its preamble.
*/
const RICH_PACK = { name: "rich-answers", category: "communication" };

function renderRichPack(): string {
  return [
    "---",
    `name: ${RICH_PACK.name}`,
    `description: ${y(
      "How to show figures in the chat as cards, charts, bars, meters and tables — " +
        "five fenced blocks the dashboard draws as live widgets. Use it whenever an " +
        "answer carries numbers.",
    )}`,
    "version: 1.0.0",
    "license: MIT",
    "platforms: [linux, macos, windows]",
    "metadata:",
    "  hermes:",
    "    tags: [chat, charts, presenting]",
    "---",
    "",
    PRESENT_GUIDE,
  ].join("\n");
}

/** The category's own description, which Hermes renders above the group in the
 *  agent's index. Cheap, and it is the one line that says these are about THIS
 *  business rather than about Stripe or GitHub in general. */

/* ----------------------------------------------------------------- the sync */

export type SkillSync = {
  /** Packs written or rewritten because their content differed. */
  written: string[];
  /** Packs deleted because their integration is no longer connected. */
  removed: string[];
  /**
   * Whether anything on disk moved. The caller uses this to decide whether a
   * RUNNING agent has to be restarted — see the note in agents/instance.ts —
   * so it must be false on a no-op sync, which is why every write below is
   * compared against what is already there rather than performed blindly.
   */
  changed: boolean;
};

/**
 * Bring `<skillsDir>/opc/` into line with what is connected right now.
 *
 * IT ONLY EVER TOUCHES ITS OWN CATEGORY, and within it only directories whose
 * name starts with `opc-`. Hermes seeds `$HERMES_HOME/skills/` with fifty-seven
 * bundled skills and lets the agent write its own there; a sync that deleted
 * "everything not in the registry" would delete the agent's memory of its own
 * work the first time somebody disconnected a plugin. The prefix is what makes
 * "these are ours" a decidable question.
 */
export function syncHermesSkills(
  skillsDir: string,
  opts: {
    /** Where the `opc` wrapper is, for the one line in each pack that says
     *  what to type when the shell cannot find it. */
    cli?: string | null;
  } = {},
): SkillSync {
  const live = skills();
  const cli = opts.cli ?? null;
  const written: string[] = [];
  const removed: string[] = [];

  // The bundle layout, gone for good. Removing the whole directory is safe
  // because nothing but this app ever wrote into a category called `opc`.
  const legacy = join(skillsDir, LEGACY_CATEGORY);
  if (existsSync(legacy)) {
    rmSync(legacy, { recursive: true, force: true });
    removed.push(`${LEGACY_CATEGORY}/`);
  }

  /* Path → the file's whole content, so the skill packs and the one static
     pack are written, compared and pruned by one loop. */
  const wanted = new Map<string, string>(
    live.map((s) => [join(packCategory(s.id), packName(s.id)), render(s, cli)]),
  );
  wanted.set(join(RICH_PACK.category, RICH_PACK.name), renderRichPack());

  for (const [rel, next] of wanted) {
    const packDir = join(skillsDir, rel);
    const file = join(packDir, "SKILL.md");
    /* Compared before writing, so a reconfigure that changed nothing leaves
       every mtime alone. Hermes decides whether its cached prompt snapshot is
       stale from a manifest of those mtimes, so a blind rewrite would make
       every configure look like a skill change and cost a restart. */
    if (readIfPresent(file) === next && existsSync(join(packDir, MARKER))) continue;
    mkdirSync(packDir, { recursive: true });
    writeFileSync(file, next);
    writeFileSync(join(packDir, MARKER), "written by onepersoncompany; safe to delete\n");
    written.push(rel);
  }

  /*
    PRUNE BY MARKER, NOT BY NAME OR CATEGORY. The packs now sit in categories
    Hermes also uses, beside skills the owner or Hermes wrote. The only thing
    that distinguishes ours is the marker file, so that is the only thing
    pruning trusts — a pack without it is somebody else's and is never touched.
  */
  for (const cat of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!cat.isDirectory() || cat.name.startsWith(".") || cat.name.startsWith("_")) continue;
    const catDir = join(skillsDir, cat.name);
    for (const found of readdirSync(catDir, { withFileTypes: true })) {
      if (!found.isDirectory()) continue;
      const rel = join(cat.name, found.name);
      if (wanted.has(rel)) continue;
      if (!existsSync(join(catDir, found.name, MARKER))) continue;
      rmSync(join(catDir, found.name), { recursive: true, force: true });
      removed.push(rel);
    }
  }

  return { written, removed, changed: written.length > 0 || removed.length > 0 };
}

function readIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * A fingerprint of WHICH skills are live — not of their content.
 *
 * The watcher in agents/instance.ts compares this every fifteen seconds and
 * only calls the sync when it moves. Comparing the rendered files instead would
 * mean rendering nineteen documents four times a minute to discover that
 * nothing had changed, and comparing the plugin table directly would miss that
 * two plugins map to one skill (Gmail and Resend are both `mail`, either one of
 * them keeps it live) and restart an agent for a change it could not observe.
 */
export function liveFingerprint(): string {
  return skills()
    .map((s) => s.id)
    .join("|");
}
