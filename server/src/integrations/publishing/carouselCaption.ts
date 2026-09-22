/**
 * A CAROUSEL'S CAPTION, WHEN IT HAS NONE.
 *
 * The carousel planner asks the model for a caption alongside the six slides
 * (videoplus/carousel.ts, `PLAN_SYSTEM`), so a finished carousel almost always
 * has one. When it does not — the model left the field empty — it is written
 * here the way a Studio image post's is: one call to the workspace model, the
 * answer split into caption and hashtags by the Studio's own `splitCaption`,
 * and stored on the carousel so the Studio shows the same words the queue does.
 *
 * NO MODEL IS NOT A FAILURE TO QUEUE. A draft with the plan's own words as its
 * caption is still a draft the owner edits before approving; refusing to queue
 * a finished carousel because the model is down would be the wrong half to
 * withhold. So the fallback is built from the plan: the hook, the four points
 * and the ask, which are words the owner has already seen on the slides.
 */
import { db } from "../../db.ts";
import { complete } from "../../models/provider.ts";
import { splitCaption } from "../ventures/studio.ts";

type PlanSlide = { n?: number; role?: string; headline?: string; body?: string };

function slidesOf(raw: string | null): PlanSlide[] {
  try {
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as PlanSlide[]) : [];
  } catch {
    return [];
  }
}

/** The plan's own words as a caption: the hook, the points, the ask. */
export function captionFromPlan(title: string | null, slides: PlanSlide[]): string {
  const heads = slides.map((s) => (s.headline ?? "").trim()).filter(Boolean);
  if (!heads.length) return (title ?? "").trim();
  const [hook, ...rest] = heads;
  const ask = rest.length > 1 ? rest.pop()! : null;
  return [hook, rest.length ? rest.map((h) => `- ${h}`).join("\n") : null, ask].filter(Boolean).join("\n\n");
}

/**
 * The caption a carousel goes to Publishing with — its own if it has one,
 * otherwise written now and saved back. Never throws.
 */
export async function ensureCarouselCaption(runId: string): Promise<{ caption: string | null; source: "carousel" | "model" | "plan" | null }> {
  const row = db
    .prepare("SELECT venture_id, title, caption, slides FROM studio_carousels WHERE run_id = ?")
    .get(runId) as { venture_id: string | null; title: string | null; caption: string | null; slides: string | null } | undefined;
  if (!row) return { caption: null, source: null };
  if (row.caption?.trim()) return { caption: row.caption.trim(), source: "carousel" };

  const slides = slidesOf(row.slides);
  const fallback = captionFromPlan(row.title, slides);
  let caption: string | null = null;
  let source: "model" | "plan" = "plan";
  try {
    const reply = await complete(
      [
        {
          role: "system",
          content:
            "Write the caption that goes beside a six-slide social-media carousel. Two to four sentences " +
            "that make somebody swipe, then a last line of three to five hashtags. Use only what the slides " +
            "say; never invent a feature, a number, a price or a result. No preamble, no quotation marks.",
        },
        {
          role: "user",
          content: [
            `Carousel: ${row.title ?? "(untitled)"}`,
            ...slides.map((s, i) => `Slide ${s.n ?? i + 1}${s.role ? ` (${s.role})` : ""}: ${s.headline ?? ""}${s.body ? ` — ${s.body}` : ""}`),
          ].join("\n"),
        },
      ],
      { venture: row.venture_id ?? undefined, maxOutputTokens: 600 },
    );
    const split = splitCaption(reply.text);
    const text = [split.caption, split.hashtags.join(" ")].filter((x) => x.trim()).join("\n\n").trim();
    if (text) {
      caption = text.slice(0, 2_200);
      source = "model";
    }
  } catch {
    /* No model, or it did not answer: the plan's words below. */
  }
  caption = caption ?? (fallback || null);
  if (caption) db.prepare("UPDATE studio_carousels SET caption = ? WHERE run_id = ?").run(caption, runId);
  return { caption, source };
}
