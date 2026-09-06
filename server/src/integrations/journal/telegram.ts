/**
 * `/did` — the journal, from a phone.
 *
 * WHY IT IS HERE AND NOT IN telegram/bridge.ts. Same argument the proactive
 * area's two commands make in their own file: the bridge is a security-critical
 * file about which chat is allowed near the agent, and this is product copy
 * about how a sentence becomes a row. The bridge gains one line in its command
 * list and one branch that calls this.
 *
 * THIS IS THE DOOR THAT MAKES THE JOURNAL REAL. The work this table exists to
 * capture — a call taken, a post put somewhere, a page rewritten — happens away
 * from the desk, and a log you can only write at the desk is a log written on
 * Friday from memory. So the whole grammar is one word and a sentence.
 *
 * THE GRAMMAR, in the order it is read:
 *
 *   /did <text>                        a `did` entry, today
 *   /did shipped <text>                a leading KIND word, if it is one
 *   /did northwind shipped <text>      a leading VENTURE word, if it is one
 *   /did none <text>                   filed against no venture, deliberately
 *
 * A trailing http(s) link anywhere in the sentence becomes the entry's URL and
 * stays in the text, because the sentence should still read as the owner wrote
 * it.
 *
 * THE VENTURE IS INFERRED OR ASKED FOR, NEVER GUESSED. A name or slug appearing
 * as a word in the sentence attributes the entry; a box with exactly one
 * venture attributes to it; anything else gets a question back with the exact
 * lines to send, and NOTHING IS FILED. Filing to the wrong business is a quiet
 * error nobody catches for a month, and an unattributed row filed silently is
 * the same error wearing a null.
 *
 * IT NEVER THROWS. The bridge's generic failure sentence is the wrong answer on
 * a phone with no logs on it, so every path here ends in words.
 */
import { ventureRows } from "../../db.ts";
import {
  KINDS,
  addEntry,
  agentFiledCount,
  cleanUrl,
  entryDays,
  resolveVentureExact,
  shape,
  streak,
  today,
} from "./entries.ts";

/** How many ventures the ask-back offers before it stops listing them. */
const MAX_OFFERED = 8;

const linkIn = (text: string): string | null => {
  const m = /(https?:\/\/\S+)/i.exec(text);
  return m ? cleanUrl(m[1]!.replace(/[.,;:)\]]+$/, "")) : null;
};

/**
 * One `/did`, answered.
 *
 * `raw` is the whole message including the command word, exactly as the bridge
 * received it, so this function owns the parsing and the bridge owns nothing
 * about the grammar.
 */
export function didText(raw: string): string {
  try {
    /* Drop the command word — and `@bot` after it, which is what a Telegram
       client sends in a group. */
    const body = raw.replace(/^\/did(@\S+)?\s*/i, "").trim();
    if (!body)
      return (
        "Say what you did: “/did shipped the new pricing page”.\n\n" +
        `Kinds: ${KINDS.join(", ")} — put one first if you want it. ` +
        "Put a venture's name first to file it against that venture."
      );

    let rest = body;
    let kind = "did";
    let ventureKey: string | null = null;
    let explicitlyNone = false;

    /* The two optional leading words, in either order and at most one each.
       Read one word at a time so a sentence that simply begins with a
       venture's name is understood, and so "did" as the first word of a real
       sentence is not stolen twice. */
    for (let i = 0; i < 2; i += 1) {
      const word = rest.split(/\s+/, 1)[0] ?? "";
      const bare = word.replace(/[.,:;]+$/, "").toLowerCase();
      if (!bare) break;
      if (kind === "did" && (KINDS as readonly string[]).includes(bare) && rest.slice(word.length).trim()) {
        kind = bare;
        rest = rest.slice(word.length).trim();
        continue;
      }
      if (ventureKey === null && !explicitlyNone && bare === "none" && rest.slice(word.length).trim()) {
        explicitlyNone = true;
        rest = rest.slice(word.length).trim();
        continue;
      }
      if (ventureKey === null && !explicitlyNone && rest.slice(word.length).trim()) {
        /* EXACT, not a prefix. A prefix here would strip the first word of an
           ordinary sentence: a box with a venture called "Postal" would read
           "/did post the update" as "post" naming Postal and file "the update"
           against a business it has nothing to do with. See resolveVentureExact
           in entries.ts — the prefix rule stays where somebody has said "this
           is a venture name" by putting it in the `venture` field. */
        const v = resolveVentureExact(bare);
        if (v) {
          ventureKey = v.id;
          rest = rest.slice(word.length).trim();
          continue;
        }
      }
      break;
    }

    if (!rest) return "That was a kind and a venture with nothing after them. Say what you did.";

    /* A name anywhere in the sentence, when it was not the first word. Only
       whole words, and only when exactly one venture matches: "the Northwind
       and Acme pricing pages" names two businesses and this cannot
       know which one the work was for. */
    const ventures = ventureRows();
    let ambiguous: string[] = [];
    if (!ventureKey && !explicitlyNone) {
      const words = new Set(rest.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []);
      const hits = ventures.filter(
        (v) => words.has(v.name.toLowerCase()) || words.has(v.slug.toLowerCase()),
      );
      if (hits.length === 1) ventureKey = hits[0]!.id;
      else if (hits.length > 1) ambiguous = hits.map((v) => v.name);
      else if (ventures.length === 1) ventureKey = ventures[0]!.id;
    }

    if (!ventureKey && !explicitlyNone && ventures.length > 1) {
      const offered = ventures.slice(0, MAX_OFFERED);
      const lines = [
        ambiguous.length
          ? `That names ${ambiguous.join(" and ")} — which one is it for?`
          : "Which venture is that for?",
        "",
        ...offered.map((v) => `/did ${v.slug} ${kind === "did" ? "" : `${kind} `}${rest}`),
        `/did none ${kind === "did" ? "" : `${kind} `}${rest}`,
      ];
      if (ventures.length > offered.length)
        lines.push("", `…and ${ventures.length - offered.length} more. Any venture's name or slug works.`);
      lines.push("", "Nothing has been filed yet — send one of those.");
      return lines.join("\n");
    }

    const out = addEntry({
      kind,
      text: rest,
      venture: ventureKey ?? undefined,
      url: linkIn(rest) ?? undefined,
      source: "telegram",
    });
    if ("error" in out) return out.error;

    const e = shape(out.entry);
    const s = streak(entryDays(), today(), agentFiledCount());
    const where = e.venture ? ` · ${e.venture.name}` : " · no venture";
    const run =
      s.current > 1
        ? `\n${s.current} days in a row${s.today ? "" : " (nothing yet today)"}.`
        : "";
    return (
      `Filed — ${e.kind}${where} · ${e.at}\n“${e.text}”` +
      (e.url ? `\n${e.url}` : "") +
      run +
      (e.trackable
        ? "\n\nIt has a link, so its effect can be tracked from the Journal page — pick the metric there."
        : "")
    );
  } catch (err) {
    return `That could not be filed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
