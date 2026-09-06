/**
 * READING A BOOLEAN OFF THE WIRE, ONCE, FOR THIS WHOLE AREA.
 *
 * THE SKILLS PROXY SENDS EVERY PARAMETER AS A STRING. `skills/registry.ts`'s
 * `SkillParam.type` is `"number" | "string"` and nothing else; `cli/opc.ts`
 * stringifies anything that is not a number; `skills/mcp.ts` publishes
 * `type: "string"` in the tool schema; `routes/skills.ts` forwards the value
 * verbatim. So a route that tests `body.dry === true` receives `"true"` and
 * reads it as FALSE — and that exact line once published a real Facebook post
 * while an agent believed it was rehearsing.
 *
 * TWO RULES CAME OUT OF THAT, AND THIS FILE IS HALF OF THE SECOND ONE.
 *
 *   1. A rehearsal is its OWN route that hard-codes `dry: true` and reads
 *      nothing about it from the request. `POST /api/pipeline/plan` and
 *      `POST /api/synthesis/plan` are those routes; the real ones refuse the
 *      word `dry` outright and say where to send it. There is therefore no
 *      boolean anywhere near the decision that spends money.
 *   2. Every OTHER boolean — `cancel`, `enabled`, `proposals` — is read
 *      through `readBool` below, which accepts what a proxy, a CLI and a JSON
 *      client each actually send, and REFUSES anything else rather than
 *      guessing. A silent false is how the first bug happened; a 400 with the
 *      accepted spellings in it is a bug somebody fixes in ten seconds.
 *
 * `null` IS A THIRD ANSWER AND IT IS NOT AN ERROR. On the per-stage overrides
 * it means "restore this stage's own default", which is distinct from `false`,
 * so the reader has to be able to return it — including as the STRING "null",
 * which is the only way an agent can express it through the proxy.
 */

export type BoolRead =
  | { ok: true; value: boolean }
  | { ok: true; value: null }
  | { ok: false; error: string };

const TRUE = new Set(["true", "yes", "on", "1"]);
const FALSE = new Set(["false", "no", "off", "0"]);
const NULLISH = new Set(["null", "default", ""]);

/**
 * Read one boolean parameter.
 *
 * `allowNull` decides whether `null` is a legal answer for THIS parameter, and
 * it is passed rather than inferred because the two cases are genuinely
 * different: "un-skip tonight" has no third state, and "restore this stage's
 * default" has nothing else. Where it is not allowed, a null is refused with
 * the same sentence as a typo — a caller that sent one meant something, and
 * quietly treating it as false is the failure this file exists to end.
 */
export function readBool(
  value: unknown,
  field: string,
  opts: { allowNull?: boolean } = {},
): BoolRead {
  if (typeof value === "boolean") return { ok: true, value };
  if (value === null || value === undefined) {
    if (opts.allowNull) return { ok: true, value: null };
    return { ok: false, error: `\`${field}\` is required: true or false.` };
  }
  if (typeof value === "number") {
    if (value === 1) return { ok: true, value: true };
    if (value === 0) return { ok: true, value: false };
    return { ok: false, error: `\`${field}\` is true or false; ${value} is neither.` };
  }
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (TRUE.has(t)) return { ok: true, value: true };
    if (FALSE.has(t)) return { ok: true, value: false };
    if (opts.allowNull && NULLISH.has(t)) return { ok: true, value: null };
  }
  return {
    ok: false,
    error:
      `\`${field}\` could not be read as a boolean. Send true or false (JSON), or one of ` +
      `"true"/"false", "yes"/"no", "on"/"off", "1"/"0"` +
      `${opts.allowNull ? `, or "null" to restore the default` : ""}. ` +
      `It is refused rather than guessed at, because a boolean read wrongly here changes what runs.`,
  };
}

/**
 * THE `dry` GUARD ON A ROUTE THAT REALLY RUNS.
 *
 * It does not parse the value. It refuses the FIELD, whatever is in it, and
 * names the route that rehearses instead. A route that accepted `dry: false`
 * would still be a route where a mistyped `dry` decides whether money is spent,
 * and the whole point of splitting the two is that no such route exists here.
 */
export function refuseDry(body: Record<string, unknown> | null, planRoute: string): string | null {
  if (!body || !("dry" in body)) return null;
  return (
    `This route always runs for real and does not take a \`dry\` flag — ` +
    `a rehearsal is its own route, so that no typo can turn one into the other. ` +
    `Send this to ${planRoute} instead: it plans without executing and spends nothing.`
  );
}
