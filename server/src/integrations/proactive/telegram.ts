/**
 * THE TWO SENTENCES THIS AREA SAYS ON A PHONE.
 *
 * WHY IT IS HERE AND NOT IN telegram/bridge.ts. The bridge is one of the
 * shared files eight areas edit, and its own header is about one thing: which
 * chat is allowed near the agent. Everything below is about alerts and
 * briefings — what they are, how they are worded, what to say when there are
 * none — and putting it there would grow a security-critical file with product
 * copy. So the bridge gains two lines in its command list and two branches
 * that call these; the copy lives with the feature.
 *
 * NEITHER OF THESE THROWS. A command that raised would be answered by the
 * bridge's generic failure sentence, and the owner is holding a phone with no
 * logs on it: every path here ends in words.
 *
 * PLAIN TEXT, NOT HTML. The bridge's own two commands use HTML because they
 * are printing ids and labels that want a monospace run; these are printing a
 * briefing that a model wrote, which can contain anything at all — a stray `<`
 * in it would be a parse error Telegram answers with a 400. `plainRich` takes
 * the rich blocks down to their figures on the way out, which is what the
 * chat bridge already does with every answer it sends.
 */
import { plainRich } from "../../skills/present.ts";
import { build, settings, zoned } from "./briefing.ts";
import { briefing, events, latestBriefing, rules } from "./store.ts";

/** How many open events one message names. Past this it says how many more. */
const MAX_EVENTS = 8;

/**
 * `/briefing` — send today's, building it first if it does not exist yet.
 *
 * BUILDING ON DEMAND IS THE POINT. Asking for the briefing at six when it is
 * scheduled for seven should produce a briefing, not "come back later" — and
 * the day is the key, so the one built now is the one the timer would have
 * built and the timer will not build a second.
 */
export async function briefingText(): Promise<string> {
  try {
    const s = settings();
    const { day } = zoned(s.timezone);
    let row = briefing(day) ?? null;
    if (!row) {
      const built = await build();
      row = built.row;
    }
    if (!row) {
      const last = latestBriefing();
      if (!last) return "No briefing has been built yet, and one could not be built just now.";
      row = last;
    }
    const body = row.markdown.trim();
    if (!body)
      return (
        `Briefing — ${row.day}\n\n` +
        (row.note ?? "No write-up was produced.") +
        "\n\nThe facts it was assembled from are on the Alerts → Briefing page."
      );
    return `Briefing — ${row.day}\n\n${plainRich(body)}`;
  } catch (err) {
    return `The briefing could not be produced: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * `/alerts` — what is open, in one message.
 *
 * TRIPS AND UNREADABLES ARE LISTED SEPARATELY AND LABELLED. They are the same
 * table and they are not the same news: one is a figure crossing a line the
 * owner drew, the other is a document that could not be read at all. A phone
 * message that ran them together would be the exact confusion this area's
 * rules exist to prevent.
 */
export function alertsText(): string {
  try {
    const all = rules();
    if (!all.length)
      return "No alert rules are set up on this box, so nothing is being watched. Add one on the Alerts page.";

    const open = events({ openOnly: true, kinds: ["trip", "unreadable"], limit: 200 });
    if (!open.length)
      return `Nothing is open. ${all.filter((r) => r.enabled === 1).length} rule(s) are watching.`;

    const byRule = new Map(all.map((r) => [r.id, r]));
    const trips = open.filter((e) => e.kind === "trip");
    const dark = open.filter((e) => e.kind === "unreadable");
    const lines: string[] = [
      `${open.length} open — ${trips.length} tripped, ${dark.length} unreadable.`,
    ];

    if (trips.length) {
      lines.push("", "Tripped:");
      for (const e of trips.slice(0, MAX_EVENTS))
        lines.push(`• ${e.ts.slice(0, 16).replace("T", " ")} — ${e.message}`);
      if (trips.length > MAX_EVENTS) lines.push(`  …and ${trips.length - MAX_EVENTS} more.`);
    }

    if (dark.length) {
      lines.push(
        "",
        "Could not be read (this is a rule or a plugin problem, not a business figure):",
      );
      for (const e of dark.slice(0, MAX_EVENTS))
        lines.push(`• ${byRule.get(e.rule_id)?.name ?? `rule ${e.rule_id}`} — ${e.message}`);
      if (dark.length > MAX_EVENTS) lines.push(`  …and ${dark.length - MAX_EVENTS} more.`);
    }

    lines.push("", "Acknowledge them on the Alerts page; the rules keep watching either way.");
    return lines.join("\n");
  } catch (err) {
    return `The alerts could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }
}
