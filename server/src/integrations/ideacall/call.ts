/**
 * THE IDEA CALL — a conversation that refines one idea, looks things up while
 * it talks, and writes what is settled into the idea page.
 *
 * WHY IT IS NOT THE CHAT. The Chief of Staff answers questions about a running
 * estate; this asks them, about something that does not exist yet. Its replies
 * are SPOKEN — two or three sentences, one question, no lists — and its job is
 * done when the idea page's six fields, its alternatives and its name shortlist
 * say something true. So it has its own brief, its own eight tools
 * (./tools.ts) and its own transcript (idea_call_turns), and shares with the
 * chat only the door to the model.
 *
 * ONE TURN IS A BOUNDED LOOP over `completeTooled`: ask, run whatever tools it
 * asked for, hand back the results, ask again, until it speaks or the rounds
 * run out. Each round is a whole completion, not a token stream — the page
 * reveals the reply a word at a time on its own, so tokens arriving early would
 * buy nothing, and the caption under the orb is fed by the tool events instead.
 *
 * A PROVIDER THAT REFUSES `tools` STILL GETS A CALL. It can talk and it cannot
 * look anything up or write; the hang-up pass (`finishCall`) then reads the
 * transcript and files what was settled, which is also the safety net for a
 * model that had tools and forgot to use the writing ones.
 */
import { db, type VentureRow } from "../../db.ts";
import { activeProvider, complete, completeTooled, providers, type ProviderId, type ToolWireTurn } from "../../models/provider.ts";
import { configValue } from "../../db.ts";
import { runContext } from "../../runtime/budgets.ts";
import { assistantCallTurn, messageText, parseToolCalls, resultTurn } from "../runtime/tools.ts";
import { verdictFor } from "../runtime/probe.ts";
import { PROFILE_FIELDS } from "../../../../shared/ventureJourney.ts";
import { storedBusinessTypes } from "../../../../shared/businessTypes.ts";
import { readJourney } from "../ventures/journey.ts";
import { knownRivals } from "../runs/competitors.ts";
import { IDEA_FIELDS, TOOLS, applyCompetitors, applyIdea, emptyUpdate, runIdeaTool, toolLabel, type IdeaUpdate } from "./tools.ts";

const MAX_ROUNDS = 8;
const HISTORY_TURNS = 40;
const RESEARCH_CHARS = 900;
const TURN_MS = 5 * 60_000;

export const IDEACALL_PLUGIN = "ideacall";
const HOSTED: ProviderId[] = ["freellmapi", "openrouter", "openai"];

/**
 * WHO TAKES THE CALL. The workspace's model, with one exception that is about
 * the shape of the work and not about quality: a LOCAL model set to take one
 * job at a time cannot hold a conversation while it is an hour into somebody's
 * report — every reply would wait for the run in front of it. When that is the
 * workspace's choice and a hosted provider is also connected, the call goes to
 * the hosted one, and SAYS SO (`reason`), because an idea spoken aloud to a box
 * in the cupboard and one sent to a gateway are different things and the owner
 * is entitled to know which is happening. `provider` under the ideacall
 * settings pins it either way — "local" included.
 */
export function callProvider(): { id: ProviderId; label: string; reason: string | null; model: string | null } | null {
  const connected = providers().filter(p => p.connected);
  const named = (id: ProviderId) => connected.find(p => p.id === id);
  const pinned = configValue(IDEACALL_PLUGIN, "provider") as ProviderId | null;
  /* A model is only ever chosen TOGETHER with its provider, so it is only
     applied to that provider: a model id means nothing to a different one. */
  if (pinned && named(pinned)) return { id: pinned, label: named(pinned)!.label ?? pinned, reason: null, model: configValue(IDEACALL_PLUGIN, "model")?.trim() || null };
  const active = activeProvider();
  if (!active) return null;
  if (active.id === "local" && active.policy.mode === "series") {
    const hosted = HOSTED.map(named).find(Boolean);
    if (hosted) return { id: hosted.id, label: hosted.label ?? hosted.id, model: null, reason: `${active.label} answers one job at a time, so the call is with ${hosted.label ?? hosted.id} instead.` };
  }
  return { id: active.id, label: active.label, reason: null, model: null };
}

export type CallTurn = { id: number; role: "user" | "assistant"; text: string; at: string };
export type CallEvent =
  | { type: "tool"; id: string; tool: string; label: string; status: "running" | "completed" }
  | { type: "updated"; update: IdeaUpdate }
  | { type: "say"; turn: CallTurn };

type Row = { id: number; ts: string; role: "user" | "assistant"; content: string; research: string | null };

export function callTurns(ventureId: string): CallTurn[] {
  return (db.prepare("SELECT id, ts, role, content FROM idea_call_turns WHERE venture_id = ? ORDER BY id").all(ventureId) as unknown as Row[])
    .map(r => ({ id: r.id, role: r.role, text: r.content, at: r.ts }));
}

export function resetCall(ventureId: string): number {
  return Number(db.prepare("DELETE FROM idea_call_turns WHERE venture_id = ?").run(ventureId).changes);
}

function append(ventureId: string, role: "user" | "assistant", content: string, research: string | null = null): CallTurn {
  const at = new Date().toISOString();
  const id = Number(db.prepare("INSERT INTO idea_call_turns (venture_id, ts, role, content, research) VALUES (?, ?, ?, ?, ?)").run(ventureId, at, role, content, research).lastInsertRowid);
  return { id, role, text: content, at };
}

/** What the idea page says right now — re-read every turn, because the owner
 *  can edit the page between calls and the call itself writes to it. */
function pageBlock(venture: VentureRow): string {
  const doc = readJourney(venture), profile = doc.state.profile;
  const fields = IDEA_FIELDS.map(key => `- ${PROFILE_FIELDS[key]} [${key}]: ${profile[key]?.trim() || "(empty)"}`).join("\n");
  const rivals = knownRivals(venture.id).slice(0, 12).map(k => `- ${k.name}${k.url ? ` (${k.url})` : ""}${k.positioning ? `: ${k.positioning.slice(0, 160)}` : ""}`).join("\n");
  const names = doc.state.names.map(n => `- ${n.name} / ${n.domain}: ${n.status}`).join("\n");
  return [
    `Name: ${venture.name}`,
    `Description: ${venture.description.trim() || "(empty)"}`,
    `Website: ${venture.website ?? "(none yet)"}`,
    `Kind of business: ${storedBusinessTypes(venture).join(", ") || "(not chosen)"}`,
    `\nThe plan on the idea page:\n${fields}`,
    `\nAlternatives already on the page:\n${rivals || "(none)"}`,
    `\nNames being considered:\n${names || "(none)"}`,
  ].join("\n");
}

function brief(venture: VentureRow, tools: boolean): string {
  return [
    `You are on a voice call with a solo founder, helping refine one business idea until it is sharp enough to test. Everything you say is spoken aloud and shown in large type, one thought at a time.`,
    `\nHOW TO TALK\n- Two or three short sentences per reply, under sixty words, then stop. Ask ONE question at a time. This holds after research too: give the one finding that changes the idea and what it means, never a rundown of everything you read. The details are already saved to the page, where they can be read.\n- Plain spoken English. No lists, no markdown, no headings, no emoji, no URLs read aloud, never say a field's name in brackets.\n- Be a sharp, warm thinking partner: reflect back what is really being said, name the weak point, push for specifics (who exactly, what happened last time, what would they pay). Disagree when the evidence disagrees.\n- Do not recite what is already on the page; build on it.`,
    tools
      ? `\nHOW TO WORK\n- Look things up instead of guessing: search for who already does this, read their pages and prices, check what people complain about, check how hard the search phrase is, check the App Store if it could be an app, check domains before suggesting a name. Say in a few words that you are going to look, then do it.\n- The moment something is settled, write it down with update_idea. Fill the empty fields first; rewrite a filled one when the conversation has moved past it. Write in the founder's own plain words, one to three sentences a field.\n- Every real competitor you come across goes on the page with save_competitors, with its actual website. Aim to have the three to six that matter by the end of the call.\n- A name worth keeping, or one that turned out to be taken, goes on the page with save_name after you have checked its domain.\n- After writing, carry on the conversation; mention what you noted in passing, not as a report.`
      : `\nYou cannot look anything up on this connection, so say so once if it matters, and work from what the founder knows.`,
    `\nTHE IDEA PAGE RIGHT NOW\n${pageBlock(venture)}`,
  ].join("\n");
}

function history(ventureId: string): ToolWireTurn[] {
  const rows = (db.prepare("SELECT id, ts, role, content, research FROM idea_call_turns WHERE venture_id = ? ORDER BY id DESC LIMIT ?").all(ventureId, HISTORY_TURNS) as unknown as Row[]).reverse();
  return rows.map(r => ({ role: r.role, content: r.research ? `${r.content}\n\n[What you looked up during this turn, not spoken aloud:\n${r.research}]` : r.content }));
}

/** Spoken text has no markup. A model that was told so and wrote some anyway
 *  should not have its asterisks read out. */
export function spoken(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```[\s\S]*?```/g, " ").replace(/^\s{0,3}(#{1,6}|[-*•]|\d+[.)])\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?]|$)/g, "$1$2").replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
}

/**
 * One turn of the call. `message: null` opens the line.
 *
 * The owner's words are stored BEFORE the model is asked, so a turn that dies
 * half-way still shows what was said on the next call.
 */
export async function* callTurn(venture: VentureRow, message: string | null, signal: AbortSignal): AsyncGenerator<CallEvent> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(TURN_MS)]);
  const past = history(venture.id);
  if (message !== null) append(venture.id, "user", message);
  const stage = message !== null ? message
    : past.length ? "(The founder has just rejoined the call. Welcome them back in one sentence, say where you had got to, and carry on with the next question.)"
    : "(The call has just connected. Greet them in one short sentence and ask your first question — about whatever on the idea page is weakest or missing.)";

  let toolsOn = true;
  const on = callProvider(), provider = on?.id, model = on?.model ?? undefined;
  const wire: ToolWireTurn[] = [{ role: "system", content: brief(venture, true) }, ...past, { role: "user", content: stage }];
  /* One object, reused, so every round of the turn is charged to one run and
     to this venture — see `directTurn` in integrations/runtime/loop.ts. */
  const ctx = { id: `idea-call:${venture.id}:${Date.now().toString(36)}`, venture: venture.id, automation: false, signal: bounded, sequence: 0, resume: false };
  const ask = (tools: boolean) => runContext.run(ctx, () => completeTooled(wire, { provider, model, tools: tools ? TOOLS : undefined, toolChoice: tools ? "auto" : undefined, signal: bounded, maxOutputTokens: 1200 }));

  const update = emptyUpdate();
  const research: string[] = [];
  let said = "";
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS;
    if (last) wire.push({ role: "user", content: "(Stop looking things up now and answer the founder with what you have.)" });
    let reply: Awaited<ReturnType<typeof ask>>;
    try { reply = await ask(toolsOn && !last); }
    catch (err) {
      if (!toolsOn || last || verdictFor(err).mode !== "text") throw err;
      toolsOn = false;
      wire[0] = { role: "system", content: brief(venture, false) };
      reply = await ask(false);
    }
    const { calls } = parseToolCalls(reply.message);
    const text = messageText(reply.message) || reply.text;
    if (!calls.length || last || !toolsOn) { said = text; break; }

    wire.push(assistantCallTurn(text, calls, "openai"));
    for (const call of calls) {
      const label = toolLabel(call.name, call.args);
      yield { type: "tool", id: call.id, tool: call.name, label, status: "running" };
      const before = JSON.stringify(update);
      const result = call.badJson !== null ? "Those arguments were not valid JSON. Send them again." : await runIdeaTool(call.name, call.args, venture, update, bounded);
      wire.push(resultTurn(call, result, "openai"));
      if (!call.name.startsWith("update_") && !call.name.startsWith("save_")) research.push(`${label} ${JSON.stringify(call.args)} → ${result.slice(0, RESEARCH_CHARS)}`);
      yield { type: "tool", id: call.id, tool: call.name, label, status: "completed" };
      if (JSON.stringify(update) !== before) yield { type: "updated", update: structuredClone(update) };
    }
  }

  const text = spoken(said) || "I lost my thread for a second. Say that again?";
  yield { type: "say", turn: append(venture.id, "assistant", text, research.length ? research.join("\n\n").slice(0, 6000) : null) };
}

/**
 * HANGING UP. One pass over the transcript that files what was settled and not
 * yet written — all of it, for a model that had no tools; the leftovers, for
 * one that did. It returns only what it CHANGED, so a call that wrote as it
 * went ends with nothing to report, which is the good outcome.
 */
export async function finishCall(venture: VentureRow, signal?: AbortSignal): Promise<IdeaUpdate> {
  const update = emptyUpdate();
  const turns = callTurns(venture.id);
  if (turns.filter(t => t.role === "user").length < 1) return update;
  const transcript = turns.slice(-HISTORY_TURNS).map(t => `${t.role === "user" ? "Founder" : "You"}: ${t.text}`).join("\n");
  const reply = await runContext.run(
    { id: `idea-call-finish:${venture.id}:${Date.now().toString(36)}`, venture: venture.id, automation: false, signal: signal ?? AbortSignal.timeout(120_000), sequence: 0, resume: false },
    () => complete([
      { role: "system", content: `You keep the notes for a call in which a founder refined a business idea. Compare the transcript with the idea page and return ONLY what the call settled that the page does not say yet, or now says wrongly. Reply with one JSON object and nothing else. Keys, all optional: "description", ${IDEA_FIELDS.map(k => `"${k}" (${PROFILE_FIELDS[k]})`).join(", ")} — each a string of one to three plain sentences in the founder's words; and "competitors": an array of {"name","url","positioning","pricing"} for real companies named in the call WITH a website that was actually seen, never guessed. Leave a key out when the page is already right or the call did not settle it. {} is a good answer.` },
      { role: "user", content: `THE IDEA PAGE\n${pageBlock(venture)}\n\nTHE CALL\n${transcript}` },
    ], { provider: callProvider()?.id, model: callProvider()?.model ?? undefined, jsonObject: true, maxOutputTokens: 2000, signal }),
  );
  const match = /\{[\s\S]*\}/.exec(reply.text);
  if (!match) return update;
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(match[0]) as Record<string, unknown>; } catch { return update; }
  applyIdea(venture, doc, update);
  if (Array.isArray(doc.competitors) && doc.competitors.length) applyCompetitors(venture, doc, update);
  return update;
}
