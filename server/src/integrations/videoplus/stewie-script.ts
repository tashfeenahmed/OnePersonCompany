import { complete, type VisionTurn } from "../../models/provider.ts";

export type PreparedReel = { messages: VisionTurn[]; grounded: boolean; sources: { title: string; url: string }[] };

/** The render relay supplies its research and format; all inference stays on the
 * workspace's central provider, with the same budget, cancellation and policy. */
export async function writeStewieScript(prepared: PreparedReel, signal?: AbortSignal) {
  if (!Array.isArray(prepared.messages) || !prepared.messages.length || prepared.messages.length > 10 ||
      prepared.messages.some(message => !["system", "user"].includes(message.role) || typeof message.content !== "string" || message.content.length > 40_000)) {
    throw new Error("The render relay returned an invalid script brief. Update the render relay agent and retry.");
  }
  const reply = await complete(prepared.messages, { signal });
  // Reject malformed output before the render relay queues a GPU wake/render.
  if (reply.text.length > 16_000) throw new Error("The script was too long. No render was started; try again.");
  const first = reply.text.indexOf("[");
  const last = reply.text.lastIndexOf("]");
  let lines: unknown;
  try { lines = JSON.parse(reply.text.slice(first, last + 1)); } catch { /* validated below */ }
  if (!Array.isArray(lines) || lines.length !== 6 || lines.some((line, i) =>
    !line || line.character !== (i % 2 ? "Stewie" : "Peter") || typeof line.text !== "string" || !line.text.trim() || line.text.length > 500)) {
    throw new Error("The selected model did not return six alternating Peter and Stewie lines. No render was started; try again.");
  }
  return { text: reply.text, provider: reply.provider, model: reply.model, grounded: prepared.grounded === true, sources: prepared.sources ?? [] };
}
