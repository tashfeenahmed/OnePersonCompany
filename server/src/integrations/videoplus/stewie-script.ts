import { complete, type VisionTurn } from "../../models/provider.ts";

/** `lines` is how many lines the relay asked the model for, from the run's
 *  length in seconds. An older relay sends none and always asked for six. */
export type PreparedReel = { messages: VisionTurn[]; grounded: boolean; sources: { title: string; url: string }[]; lines?: number };

/** The render relay supplies its research and format; all inference stays on the
 * workspace's central provider, with the same budget, cancellation and policy. */
export async function writeStewieScript(prepared: PreparedReel, signal?: AbortSignal, ventureId: string | null = null) {
  if (!Array.isArray(prepared.messages) || !prepared.messages.length || prepared.messages.length > 10 ||
      prepared.messages.some(message => !["system", "user"].includes(message.role) || typeof message.content !== "string" || message.content.length > 40_000)) {
    throw new Error("The render relay returned an invalid script brief. Update the render relay agent and retry.");
  }
  /* NO `jsonObject` HERE, DELIBERATELY. The other video writers in this folder
     set it; this one must not. `response_format: {type:"json_object"}` obliges
     the model to answer with an OBJECT, and what this function validates — and
     what the render relay's own prompt asks for — is a BARE ARRAY of lines
     (`Array.isArray(lines)` below). Turning the flag on here would make every
     render fail. The prompt is the relay's, not ours, so it cannot be moved to
     an object from this side either. */
  const want = Number.isInteger(prepared.lines) && prepared.lines! >= 6 && prepared.lines! <= 42 && prepared.lines! % 2 === 0 ? prepared.lines! : 6;
  const reply = await complete(prepared.messages, { signal, venture: ventureId });
  // Reject malformed output before the render relay queues a GPU wake/render.
  if (reply.text.length > 32_000) throw new Error("The script was too long. No render was started; try again.");
  const first = reply.text.indexOf("[");
  const last = reply.text.lastIndexOf("]");
  let lines: unknown;
  try { lines = JSON.parse(reply.text.slice(first, last + 1)); } catch { /* validated below */ }
  if (!Array.isArray(lines) || lines.length !== want || lines.some((line, i) =>
    !line || line.character !== (i % 2 ? "Stewie" : "Peter") || typeof line.text !== "string" || !line.text.trim() || line.text.length > 500)) {
    throw new Error(`The selected model did not return ${want} alternating Peter and Stewie lines. No render was started; try again.`);
  }
  return { text: reply.text, provider: reply.provider, model: reply.model, grounded: prepared.grounded === true, sources: prepared.sources ?? [] };
}
