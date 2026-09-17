/**
 * GETTING ONE JSON OBJECT OUT OF WHAT A MODEL ACTUALLY SENDS.
 *
 * Both writers in this area ask for "one JSON object and nothing else", and
 * both of them get it most of the time. What they get the rest of the time,
 * measured against the provider configured on this box on 2026-09-06, is a
 * paragraph of the model thinking out loud and then the object; a fenced
 * block; a bare array where an object was asked for; or an object with a
 * sentence after it. Every one of those contains the answer.
 *
 * SO THE EXTRACTION IS FOUR ATTEMPTS IN CONFIDENCE ORDER and the last one is
 * the important one: an anchored scan that starts at the key the caller
 * actually wants (`scenes`, `lines`) and walks BACKWARDS to the brace that
 * opens the object holding it. First-brace-to-last-brace — which is what the
 * rest of this codebase does — fails on exactly one shape, and it is a common
 * one: a reply whose reasoning contains a brace of its own before the real
 * object begins.
 *
 * WHAT THIS DOES NOT DO IS REPAIR. Nothing here closes an unbalanced brace,
 * strips a trailing comma or guesses a missing quote. A model that produced
 * broken JSON produced a broken answer, and the caller's job is to say so and
 * ask again — not to invent the half that did not arrive.
 */

/** A fenced block, if the reply wrapped its answer in one. */
function fenced(text: string): string[] {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

const parse = (body: string): unknown => {
  try {
    return JSON.parse(body.trim()) as unknown;
  } catch {
    return undefined;
  }
};

const has = (v: unknown, key: string) =>
  !!v && typeof v === "object" && !Array.isArray(v) && key in (v as Record<string, unknown>);

/**
 * The object the model was asked for, or null.
 *
 * `key` is the field that proves it is the right object — the caller's own
 * `scenes` or `lines`. A candidate that parses but does not carry it is
 * skipped rather than returned, because a model that answered with `{"ok":
 * true}` before its real answer would otherwise win.
 *
 * A BARE ARRAY IS ACCEPTED AND WRAPPED. Asked for `{ lines: [...] }`, models
 * routinely answer with the array alone; that is the answer, in a shape one
 * line of code can fix, and refusing it would cost a second round trip to be
 * pedantic about a container.
 */
export function readModelJson(text: string, key: string): Record<string, unknown> | null {
  const candidates: unknown[] = [];

  for (const block of fenced(text)) {
    const v = parse(block);
    if (v !== undefined) candidates.push(v);
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(parse(text.slice(first, last + 1)));

  /* A BARE RUN OF OBJECTS — `{…},\n{…},\n{…}` — which is what a model writes
     when it remembers the rows and forgets both the wrapper and the brackets
     (run r-t2iq7h: five good scenes, refused as "not an object"). Bracketed, it
     is the array candidate below; if it is not that shape the parse fails and
     nothing is added. */
  if (first >= 0 && last > first) candidates.push(parse(`[${text.slice(first, last + 1)}]`));

  const openBracket = text.indexOf("[");
  const closeBracket = text.lastIndexOf("]");
  if (openBracket >= 0 && closeBracket > openBracket) candidates.push(parse(text.slice(openBracket, closeBracket + 1)));

  /* THE ANCHORED SCAN. Find where the key is quoted, walk left to the brace
     that opens its object, then walk right counting braces (outside strings)
     until it closes. This is the attempt that survives a model that reasoned
     in prose — with braces in the prose — before answering. */
  const anchor = text.indexOf(`"${key}"`);
  if (anchor > 0) {
    let open = -1;
    let depth = 0;
    for (let i = anchor; i >= 0; i--) {
      if (text[i] === "}") depth++;
      else if (text[i] === "{") {
        if (depth === 0) {
          open = i;
          break;
        }
        depth--;
      }
    }
    if (open >= 0) {
      let level = 0;
      let inString = false;
      let escaped = false;
      for (let i = open; i < text.length; i++) {
        const ch = text[i]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') inString = !inString;
        else if (!inString && ch === "{") level++;
        else if (!inString && ch === "}") {
          level--;
          if (level === 0) {
            candidates.push(parse(text.slice(open, i + 1)));
            break;
          }
        }
      }
    }
  }

  /* TWO PASSES, AND THE ORDER IS THE POINT. An object carrying the key is
     always better than a bare array carrying the same rows, because the object
     also has the title and everything else beside it — and the array candidate
     is found earlier in the text than the anchored object on exactly the reply
     shape this exists for. A single pass would take the array and silently
     lose the rest of the answer. */
  for (const c of candidates) if (has(c, key)) return c as Record<string, unknown>;
  for (const c of candidates) if (Array.isArray(c) && c.length) return { [key]: c };
  return null;
}
