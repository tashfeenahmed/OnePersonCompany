/**
 * `/api/goals` — two documents and one verb.
 *
 * THE GLOBAL GOALS ARE AT THE ROOT AND A VENTURE'S ARE UNDER ITS KEY, which is
 * the shape a reader guesses before reading anything. `GET /api/goals` also
 * carries every venture's, so the page that draws all of them makes one request
 * rather than twenty — but each is individually addressable, because the skill
 * needs one and the chat turn needs one.
 *
 * A PUT WITH AN EMPTY BODY CLEARS, and does not 400. "I have no goal for this
 * one at the moment" is a real answer and the owner should be able to give it
 * without deleting a row; the previous text is in the history either way.
 */
import { Hono } from "hono";
import { ventureRow } from "../../db.ts";
import { MAX_GOAL, allVentureGoals, globalGoal, goalHistory, setGoal, ventureGoal } from "./goals.ts";

export const goalRoutes = new Hono();

/** Who is writing. An agent's edits are marked so the history can say which
 *  paragraph the owner typed and which one an assistant produced when asked.
 *  The skills proxy sends nothing that identifies itself, so the flag is a
 *  parameter the skill's action fills in — a caller that lies about it is a
 *  caller that could have typed the same text on the page anyway. */
function who(raw: unknown): "owner" | "agent" {
  return raw === "agent" ? "agent" : "owner";
}

goalRoutes.get("/", (c) => {
  const ventures = allVentureGoals();
  return c.json({
    global: globalGoal(),
    ventures,
    summary: {
      /* Which businesses have nothing written. The list a page needs and the
         list the owner should look at; a count of the ones that DO would hide
         it. */
      written: ventures.filter((v) => v.text.trim()).length,
      blank: ventures.filter((v) => !v.text.trim()).length,
    },
    /* Said on the document rather than only in the skill, because a person
       reading this over curl is entitled to the same rule the agent gets. */
    note:
      "These are the owner's own words. Nothing here is derived, measured or " +
      "generated; `tailorTo` is the one exception and is composed from the " +
      "venture's stage, which the owner also chose.",
  });
});

goalRoutes.get("/history", (c) => {
  const key = c.req.query("venture") ?? "";
  if (!key) return c.json({ scope: "global", ventureId: null, history: goalHistory("global", "") });
  const v = ventureRow(key);
  if (!v) return c.json({ error: `No venture by the id or slug "${key}".` }, 404);
  return c.json({ scope: "venture", ventureId: v.id, history: goalHistory("venture", v.id) });
});

goalRoutes.on(["PUT", "PATCH"], "/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown; by?: unknown } | null;
  if (!body || typeof body.text !== "string")
    return c.json({ error: "Expected { text }. Send an empty string to clear it." }, 400);
  if (body.text.length > MAX_GOAL)
    return c.json({ error: `Goals are at most ${MAX_GOAL} characters; that is ${body.text.length}.` }, 413);
  return c.json(setGoal("global", "", body.text.trim(), who(body.by)));
});

/* Declared after `/history` so the literal segment is never read as a venture
   key. React Router's rule and Hono's are the same: registration order wins. */
goalRoutes.get("/:key", (c) => {
  const doc = ventureGoal(c.req.param("key"));
  if (!doc) return c.json({ error: `No venture by the id or slug "${c.req.param("key")}".` }, 404);
  return c.json(doc);
});

/* PUT AND PATCH ARE THE SAME HANDLER HERE, and that is not sloppiness. The
   write is a whole-document replace whichever verb is used, and a skill action
   may name only POST, PATCH or DELETE (see skills/registry.ts) — so the agent's
   door has to be PATCH while the page's stays the PUT a replace deserves. Two
   verbs, one function, one set of rules. */
goalRoutes.on(["PUT", "PATCH"], "/:key", async (c) => {
  const v = ventureRow(c.req.param("key"));
  if (!v) return c.json({ error: `No venture by the id or slug "${c.req.param("key")}".` }, 404);
  const body = (await c.req.json().catch(() => null)) as { text?: unknown; by?: unknown } | null;
  if (!body || typeof body.text !== "string")
    return c.json({ error: "Expected { text }. Send an empty string to clear it." }, 400);
  if (body.text.length > MAX_GOAL)
    return c.json({ error: `Goals are at most ${MAX_GOAL} characters; that is ${body.text.length}.` }, 413);
  return c.json(setGoal("venture", v.id, body.text.trim(), who(body.by)));
});
