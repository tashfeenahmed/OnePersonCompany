/**
 * THE ALERTS ROUTES — rules in, events out, and one honest word for each.
 *
 * A RULE IS VALIDATED AGAINST THE LIVE CATALOGUE, not against a list in this
 * file. `GET /api/skills` says which skills exist, which are connected, what
 * views each has and what parameters those views take; a rule that names
 * anything else is refused with the same sentence the editor would have shown.
 * The consequence is the one that matters: this file does not have to be
 * edited when an integration is added, and it cannot fall behind one.
 *
 * A RULE AGAINST A DISCONNECTED SKILL IS REFUSED, and refused with its own
 * sentence rather than "there is no such skill" — the same distinction the
 * skills proxy draws between a 404 and a 409. The reason it cannot be allowed
 * is structural rather than a policy: the catalogue publishes no views and no
 * parameters for a skill that cannot answer, so there is no document shape to
 * check the path against, and a rule stored without that check is a rule whose
 * first evaluation is a typo nobody caught. The message names the plugins to
 * connect; connect one and the same rule stores.
 *
 * THE TEST ROUTE IS THE POINT OF THE WHOLE EDITOR. It reads the document now,
 * resolves the path now, and answers with the value, the URL it used and what
 * the comparison would say — so the owner sees the number before they save a
 * threshold, rather than finding out in a week that the path was one level
 * short. It records a `test` event so a value checked by hand is in the same
 * ledger as one checked by the timer, and it NEVER raises a trip: pressing
 * Test cannot page anybody.
 */
import { Hono } from "hono";
import { ventureRows } from "../../db.ts";
import { catalogueDoc, type Catalogue } from "./catalogue.ts";
import { judge, readRule, ruleUrl, readParams, evaluateAll } from "./engine.ts";
import { checkPath } from "../../shared/metrics-address.ts";
import {
  OPERATORS,
  THRESHOLDLESS,
  WINDOWED,
  ackEvent,
  deleteRule,
  event,
  events,
  insertEvent,
  insertRule,
  observationAtOrBefore,
  observations,
  openEventCount,
  rule,
  rules,
  updateRule,
  type EventRow,
  type Operator,
  type RuleRow,
} from "./store.ts";

export const alertRoutes = new Hono();

/* ------------------------------------------------------------------ shapes */

function shapeRule(r: RuleRow) {
  return {
    id: r.id,
    name: r.name,
    skill: r.skill,
    view: r.view,
    params: readParams(r.params),
    path: r.path,
    op: r.op,
    threshold: r.threshold,
    windowMinutes: r.window_minutes,
    ventureId: r.venture_id,
    enabled: r.enabled === 1,
    cooldownMinutes: r.cooldown_minutes,
    /* Written by this box rather than chosen by the owner. It changes nothing
       about how the rule behaves — see seed.ts. */
    seeded: r.seeded === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastEvaluatedAt: r.last_evaluated_at,
    /* The last value READ, which is not the last value that tripped. Null with
       an error beside it is the unreadable case; null with no error is a rule
       nothing has asked yet. */
    lastValue: r.last_value,
    lastError: r.last_error,
    /* The exact request this rule makes, so anybody can check the figure with
       curl. There is no secret in it: it is a loopback GET on a route the
       whole box already publishes. */
    url: ruleUrl(r),
  };
}

function shapeEvent(e: EventRow, byRule: Map<number, RuleRow>) {
  const r = byRule.get(e.rule_id);
  return {
    id: e.id,
    ruleId: e.rule_id,
    ruleName: r?.name ?? null,
    skill: r?.skill ?? null,
    path: r?.path ?? null,
    ventureId: r?.venture_id ?? null,
    ts: e.ts,
    /* trip | unreadable | test — and `unreadable` is NOT a trip. See
       101_alert_events. */
    kind: e.kind,
    observed: e.observed,
    previous: e.previous,
    message: e.message,
    narration: e.narration,
    /* Why there is no narration, when there is none. */
    narrationNote: e.narration_note,
    acknowledgedAt: e.acknowledged_at,
  };
}

/* -------------------------------------------------------------- validation */

type Parsed = {
  name: string;
  skill: string;
  view: string;
  params: Record<string, string | number>;
  path: string;
  op: Operator;
  threshold: number | null;
  windowMinutes: number | null;
  ventureId: string | null;
  enabled: boolean;
  cooldownMinutes: number;
};

/**
 * A rule from a body, checked against the catalogue.
 *
 * `partial` is how PATCH reuses this: on a partial write only the fields that
 * arrived are checked, and cross-field rules (an operator that needs a window)
 * are checked against the MERGED rule so that changing only the operator
 * cannot leave a rule that no longer makes sense.
 */
function parseRule(
  body: Record<string, unknown>,
  cat: Catalogue,
  held: RuleRow | null,
): { ok: true; value: Partial<Parsed> } | { ok: false; error: string } {
  const out: Partial<Parsed> = {};
  const has = (k: string) => k in body;
  const bad = (error: string) => ({ ok: false as const, error });

  if (has("name")) {
    const v = body.name;
    if (typeof v !== "string" || !v.trim())
      return bad("A rule needs a name — one line saying what it watches.");
    if (v.length > 120) return bad("That name is too long. One line, under 120 characters.");
    out.name = v.trim();
  }

  const skillId = has("skill") ? body.skill : (held?.skill ?? null);
  if (typeof skillId !== "string" || !skillId)
    return bad("A rule needs a skill — the document it reads. GET /api/skills lists them.");
  const skill = cat.skills.find((s) => s.id === skillId);
  if (!skill) {
    const dark = cat.disconnected.find((s) => s.id === skillId);
    if (dark)
      return bad(
        `${dark.title} is not connected here (${dark.needs.join(", ")}), so this box does not know what its document looks like and cannot check a path against it. Connect it under Integrations and write the rule then.`,
      );
    return bad(
      `There is no skill called "${skillId}". GET /api/skills lists every one, connected or not.`,
    );
  }
  if (has("skill")) out.skill = skill.id;

  const viewKey = has("view") ? body.view : has("skill") ? skill.views[0]?.key : (held?.view ?? null);
  if (viewKey !== undefined && viewKey !== null) {
    if (typeof viewKey !== "string") return bad("A view is named by its key.");
    const view = skill.views.find((v) => v.key === viewKey);
    if (!view)
      return bad(
        `${skill.id} has no view called "${viewKey}". It has: ${skill.views.map((v) => v.key).join(", ")}.`,
      );
    out.view = view.key;
  }
  const view =
    skill.views.find((v) => v.key === (out.view ?? held?.view)) ?? skill.views[0] ?? null;

  if (has("params")) {
    const p = body.params;
    if (p === null || typeof p !== "object" || Array.isArray(p))
      return bad("Parameters are a JSON object of the view's own parameters, or {}.");
    const known = new Set((view?.params ?? []).map((x) => x.name));
    const cleaned: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (v === null || v === undefined || v === "") continue;
      if (!known.has(k))
        return bad(
          `${skill.id}${view ? ` (view ${view.key})` : ""} takes no parameter "${k}". It takes: ${
            [...known].join(", ") || "none"
          }.`,
        );
      if (typeof v !== "string" && typeof v !== "number")
        return bad(`"${k}" has to be text or a number.`);
      cleaned[k] = v;
    }
    out.params = cleaned;
  }

  if (has("path")) {
    const v = body.path;
    if (typeof v !== "string") return bad("A path is text.");
    const problem = checkPath(v);
    if (problem) return bad(problem);
    out.path = v.trim();
  }

  if (has("op")) {
    const v = body.op;
    if (typeof v !== "string" || !(OPERATORS as readonly string[]).includes(v))
      return bad(`An operator is one of: ${OPERATORS.join(", ")}.`);
    out.op = v as Operator;
  }

  if (has("threshold")) {
    const v = body.threshold;
    if (v === null) out.threshold = null;
    else if (typeof v !== "number" || !Number.isFinite(v))
      return bad("A threshold is a number, or null for the operators that take none.");
    else out.threshold = v;
  }

  if (has("windowMinutes")) {
    const v = body.windowMinutes;
    if (v === null) out.windowMinutes = null;
    else if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 60 * 24 * 30)
      return bad("A window is a whole number of minutes between 1 and 43200 (thirty days).");
    else out.windowMinutes = v;
  }

  if (has("ventureId")) {
    const v = body.ventureId;
    if (v === null || v === "") out.ventureId = null;
    else if (typeof v !== "string") return bad("A venture is named by its id.");
    else {
      const known = ventureRows().some((row) => row.id === v);
      if (!known)
        return bad(`There is no venture with id "${v}". GET /api/ventures lists them.`);
      out.ventureId = v;
    }
  }

  if (has("enabled")) {
    if (typeof body.enabled !== "boolean") return bad("`enabled` is true or false.");
    out.enabled = body.enabled;
  }

  if (has("cooldownMinutes")) {
    const v = body.cooldownMinutes;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 60 * 24 * 30)
      return bad("A cooldown is a whole number of minutes between 0 and 43200.");
    out.cooldownMinutes = v;
  }

  /* Cross-field checks, against the MERGED rule — see the doc comment. */
  const op = (out.op ?? held?.op) as Operator | undefined;
  const threshold = out.threshold !== undefined ? out.threshold : (held?.threshold ?? null);
  const windowMinutes =
    out.windowMinutes !== undefined ? out.windowMinutes : (held?.window_minutes ?? null);
  if (!op) return bad("A rule needs an operator.");
  if (THRESHOLDLESS.includes(op) && threshold !== null)
    return bad(`"${op}" compares this reading with the last one, so it takes no threshold.`);
  if (!THRESHOLDLESS.includes(op) && threshold === null)
    return bad(`"${op}" needs a number to compare against.`);
  if (WINDOWED.includes(op) && !windowMinutes)
    return bad(
      `"${op}" compares against an earlier reading, so it needs a window in minutes — 10080 is a week.`,
    );
  if (WINDOWED.includes(op) && threshold !== null && threshold <= 0)
    return bad(`"${op}" takes a percentage above zero.`);

  return { ok: true, value: out };
}

async function body(c: { req: { text: () => Promise<string> } }): Promise<Record<string, unknown> | null> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    const p: unknown = JSON.parse(raw);
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    return p as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ routes */

/**
 * The overview — what is watched, what is open, and when it was last asked.
 *
 * `lastPassAt` is the newest `last_evaluated_at` across the rules rather than a
 * stored timestamp of its own, because that is the figure that can be trusted:
 * a stored "last ran at" survives a pass that read nothing, and this cannot.
 */
alertRoutes.get("/", (c) => {
  const all = rules();
  const open = events({ openOnly: true, kinds: ["trip", "unreadable"], limit: 200 });
  const evaluated = all.map((r) => r.last_evaluated_at).filter((v): v is string => !!v).sort();
  return c.json({
    rules: {
      total: all.length,
      enabled: all.filter((r) => r.enabled === 1).length,
      seeded: all.filter((r) => r.seeded === 1).length,
      unreadable: all.filter((r) => r.last_error !== null).length,
    },
    open: {
      total: open.length,
      trips: open.filter((e) => e.kind === "trip").length,
      unreadable: open.filter((e) => e.kind === "unreadable").length,
    },
    /* Null means no rule has ever been evaluated — a fresh install, or a box
       where the timer has not come round yet. It is not zero and it is not
       "never". */
    lastPassAt: evaluated.length ? evaluated[evaluated.length - 1] : null,
    generatedAt: new Date().toISOString(),
  });
});

alertRoutes.get("/rules", (c) => {
  const all = rules();
  return c.json({
    count: all.length,
    rules: all.map(shapeRule),
    /* The vocabulary, published beside the rules so a caller never has to
       guess it — and so the CLI and the page agree about what an operator is
       called. */
    operators: OPERATORS.map((op) => ({
      op,
      needsThreshold: !THRESHOLDLESS.includes(op),
      needsWindow: WINDOWED.includes(op),
      about:
        op === "changed"
          ? "Trips when the figure differs from the previous reading, whichever way it moved."
          : op === "dropped_by_pct"
            ? "Trips when the figure is at least this many percent BELOW the reading from the start of the window."
            : op === "rose_by_pct"
              ? "Trips when the figure is at least this many percent ABOVE the reading from the start of the window."
              : `Trips when the figure is ${op} the threshold.`,
    })),
  });
});

alertRoutes.get("/rules/:id", (c) => {
  const r = rule(Number(c.req.param("id")));
  if (!r) return c.json({ error: "There is no rule with that id." }, 404);
  return c.json({
    rule: shapeRule(r),
    /* Every reading this box has kept for the rule, so the page can draw the
       figure the threshold sits against rather than only the moment it
       crossed. */
    observations: observations(r.id),
    events: events({ ruleId: r.id, limit: 20 }).map((e) => shapeEvent(e, new Map([[r.id, r]]))),
  });
});

alertRoutes.post("/rules", async (c) => {
  const b = await body(c);
  if (!b) return c.json({ error: "The body of a rule is a JSON object." }, 400);
  for (const required of ["name", "skill", "path", "op"])
    if (!(required in b))
      return c.json({ error: `A rule needs "${required}".` }, 400);

  let cat: Catalogue;
  try {
    cat = await catalogueDoc(c.req.raw.signal);
  } catch (err) {
    return c.json({ error: `The skills catalogue could not be read: ${String(err)}` }, 502);
  }

  const parsed = parseRule(b, cat, null);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const v = parsed.value;

  const created = insertRule({
    name: v.name!,
    skill: v.skill!,
    view: v.view ?? cat.skills.find((s) => s.id === v.skill)?.views[0]?.key ?? "default",
    params: v.params ?? {},
    path: v.path!,
    op: v.op!,
    threshold: v.threshold ?? null,
    windowMinutes: v.windowMinutes ?? null,
    ventureId: v.ventureId ?? null,
    enabled: v.enabled ?? true,
    cooldownMinutes: v.cooldownMinutes ?? 360,
    seeded: false,
  });
  return c.json({ rule: shapeRule(created) }, 201);
});

alertRoutes.patch("/rules/:id", async (c) => {
  const held = rule(Number(c.req.param("id")));
  if (!held) return c.json({ error: "There is no rule with that id." }, 404);
  const b = await body(c);
  if (!b) return c.json({ error: "The body of a rule is a JSON object." }, 400);
  if (!Object.keys(b).length)
    return c.json(
      { error: "Nothing to change. Send name, skill, view, params, path, op, threshold, windowMinutes, ventureId, enabled or cooldownMinutes." },
      400,
    );

  let cat: Catalogue;
  try {
    cat = await catalogueDoc(c.req.raw.signal);
  } catch (err) {
    return c.json({ error: `The skills catalogue could not be read: ${String(err)}` }, 502);
  }

  const parsed = parseRule(b, cat, held);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const updated = updateRule(held.id, parsed.value);
  if (!updated) return c.json({ error: "There is no rule with that id." }, 404);
  return c.json({ rule: shapeRule(updated) });
});

/**
 * DELETE TAKES THE EVENTS WITH IT, and that is the reason it is marked
 * destructive on the skill. An event names a rule; keeping the events of a
 * deleted rule would put lines in the ledger that cannot be explained, and
 * keeping the rule disabled instead is what `enabled: false` is for.
 */
alertRoutes.delete("/rules/:id", (c) => {
  const id = Number(c.req.param("id"));
  const held = rule(id);
  if (!held) return c.json({ error: "There is no rule with that id." }, 404);
  const past = events({ ruleId: id, limit: 1000 }).length;
  deleteRule(id);
  return c.json({ deleted: id, name: held.name, eventsRemoved: past });
});

/**
 * READ IT NOW AND SAY WHAT IT SAYS. No trip is raised — see the file header.
 */
alertRoutes.post("/rules/:id/test", async (c) => {
  const r = rule(Number(c.req.param("id")));
  if (!r) return c.json({ error: "There is no rule with that id." }, 404);

  const got = await readRule(r, undefined, c.req.raw.signal);
  if (!got.ok) {
    const ev = insertEvent({
      ruleId: r.id,
      kind: "test",
      observed: null,
      previous: r.last_value,
      message: got.why,
    });
    return c.json({
      rule: shapeRule(r),
      url: got.url,
      value: null,
      /* An unreadable test is not a failure of the test route — the route did
         exactly what it was asked. It is a finding about the rule, so it
         answers 200 with the reason rather than a 502 the page would draw as
         "could not test". */
      readable: false,
      why: got.why,
      wouldTrip: false,
      eventId: ev.id,
    });
  }

  const previous = observationAtOrBefore(r.id, new Date().toISOString())?.value ?? null;
  const windowStart =
    r.window_minutes && r.window_minutes > 0
      ? observationAtOrBefore(
          r.id,
          new Date(Date.now() - r.window_minutes * 60_000).toISOString(),
        )
      : null;
  const verdict = judge(r, got.value, { previous, windowStart });
  const ev = insertEvent({
    ruleId: r.id,
    kind: "test",
    observed: got.value,
    previous: verdict.against,
    message: `Tested — ${verdict.message}`,
  });

  return c.json({
    rule: shapeRule(r),
    url: got.url,
    value: got.value,
    readable: true,
    previous,
    against: verdict.against,
    wouldTrip: verdict.tripped,
    /* Set when the comparison could not be made at all — a windowed rule with
       no reading old enough yet. It is not a pass and it is not a trip. */
    undecidable: verdict.undecidable,
    message: verdict.message,
    eventId: ev.id,
  });
});

/**
 * READ A PATH THAT IS NOT A RULE YET.
 *
 * WHY THIS EXISTS BESIDE `test`. `test` reads a SAVED rule; this reads a rule
 * somebody is still typing. Without it the editor's path field is a text box
 * with no feedback until after it has been stored, which is exactly how a rule
 * ends up watching `summary.dowm` for a week — and the failure is silent,
 * because a path that resolves to nothing is an "unreadable" event most people
 * will read as "quiet".
 *
 * IT RECORDS NOTHING. No rule, no event, no observation: it is a read of a
 * document the caller could have read themselves, resolved through the same
 * resolver the engine uses, and the answer is thrown away. That is why it is
 * not on the `alerts` skill — there is nothing here an agent cannot already do
 * with `GET /api/skills/<id>` and its own eyes, and an action that changes
 * nothing does not belong in a list of writes.
 */
alertRoutes.post("/preview", async (c) => {
  const b = await body(c);
  if (!b) return c.json({ error: "The body is a JSON object." }, 400);
  const skill = typeof b.skill === "string" ? b.skill : "";
  const path = typeof b.path === "string" ? b.path : "";
  if (!skill || !path)
    return c.json({ error: "A preview needs a skill and a path." }, 400);
  const problem = checkPath(path);
  if (problem) return c.json({ error: problem }, 400);

  const params: Record<string, string | number> = {};
  if (b.params && typeof b.params === "object" && !Array.isArray(b.params))
    for (const [k, v] of Object.entries(b.params as Record<string, unknown>))
      if (typeof v === "string" || typeof v === "number") params[k] = v;

  const probe = {
    skill,
    view: typeof b.view === "string" ? b.view : "",
    params: JSON.stringify(params),
    path,
  };
  const got = await readRule(probe, undefined, c.req.raw.signal);
  return c.json(
    got.ok
      ? { url: got.url, readable: true, value: got.value, why: null }
      : /* A path that resolves to nothing answers 200 with the reason, not a
           502: the request worked, the finding is about the path. The editor
           draws the sentence under the field. */
        { url: got.url, readable: false, value: null, why: got.why },
  );
});

alertRoutes.get("/events", (c) => {
  const days = Math.min(400, Math.max(1, Number(c.req.query("days") ?? 14) || 14));
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
  const openOnly = c.req.query("open") === "1" || c.req.query("open") === "true";
  const kindQ = c.req.query("kind");
  const kinds =
    kindQ && ["trip", "unreadable", "test"].includes(kindQ)
      ? [kindQ as EventRow["kind"]]
      : undefined;
  const rows = events({ days, limit, openOnly, kinds });
  const byRule = new Map(rules().map((r) => [r.id, r]));
  return c.json({
    window: { days, limit, openOnly, kind: kindQ ?? null },
    count: rows.length,
    /* Open means unacknowledged, and it counts `unreadable` beside `trip`: a
       watchdog that has not been able to read its document for three days is
       something to know about. `test` never counts. */
    open: openEventCount(),
    events: rows.map((e) => shapeEvent(e, byRule)),
  });
});

alertRoutes.post("/events/:id/ack", (c) => {
  const id = Number(c.req.param("id"));
  const held = event(id);
  if (!held) return c.json({ error: "There is no event with that id." }, 404);
  if (held.kind === "test")
    return c.json(
      { error: "A test is not an alert — there is nothing to acknowledge." },
      400,
    );
  const acked = ackEvent(id);
  const byRule = new Map(rules().map((r) => [r.id, r]));
  return c.json({
    event: shapeEvent(acked!, byRule),
    open: openEventCount(),
    /* Acknowledging says "I have seen this". It does NOT silence the rule: the
       same condition on the next pass raises the next event once the cooldown
       has passed. Disabling the rule is the way to stop it. */
    note: "Acknowledged. The rule is unchanged and will raise this again after its cooldown if the condition holds.",
  });
});

/**
 * RUN THE WHOLE PASS NOW.
 *
 * It exists for the page's "Check now" and for anybody debugging a rule that
 * has not fired. It is the same function the timer calls, so what it reports
 * is what the timer would have done — there is no second code path that could
 * behave differently on a Tuesday.
 */
alertRoutes.post("/evaluate", async (c) => {
  const result = await evaluateAll(c.req.raw.signal);
  const byRule = new Map(rules().map((r) => [r.id, r]));
  return c.json({
    ...result,
    raised: result.events.map((id) => {
      const e = event(id);
      return e ? shapeEvent(e, byRule) : null;
    }).filter((e) => e !== null),
  });
});
