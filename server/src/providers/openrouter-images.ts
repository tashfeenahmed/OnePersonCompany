/** OpenRouter's image endpoint uses the existing inference key, never the management key. */
import * as accounts from "../accounts.ts";
import * as vault from "../vault.ts";
import { ATTRIBUTION, CHAT_FIELD, OPENROUTER_CHAT_BASE } from "./openrouter-chat.ts";

export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2.5-sunburst";
export const OPENROUTER_IMAGE_MODELS = [DEFAULT_IMAGE_MODEL, "openai/gpt-image-2.5-flare"] as const;
export const isOpenRouterImageModel = (model: string) => OPENROUTER_IMAGE_MODELS.some((id) => id === model);
export const imageModelLabel = (model: string) => isOpenRouterImageModel(model)
  ? `GPT-image-2.5 ${model.endsWith("flare") ? "Flare" : "Sunburst"}` : model;
export const IMAGE_SIZES = { square: "1024x1024", story: "864x1536", landscape: "1536x864" } as const;
export const MISSING_IMAGE_KEY = "Add an inference key under Integrations → OpenRouter to create images. A management key only reads billing.";
const IMAGE_CAP = 12 * 1024 * 1024;
const RESPONSE_CAP = IMAGE_CAP * 4 / 3 + 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Readiness only examines entry names; it never decrypts credentials. */
export function openRouterImageAccounts() {
  return accounts.list("openrouter").filter((account) => account.connected &&
    accounts.entries(account.id).some((entry) => entry.field === CHAT_FIELD));
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("OpenRouter returned an empty image response.");
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_CAP) {
        await reader.cancel();
        throw new Error("OpenRouter's image response exceeded the 12 MB image limit.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export type OpenRouterImageResult = { ok: true; bytes: Buffer } | { ok: false; error: string };

/** One billable request, without automatic retries or fallback to another model.
 * https://openrouter.ai/docs/guides/overview/multimodal/image-generation */
export async function generateOpenRouterImage(opts: {
  model: string;
  prompt: string;
  format: keyof typeof IMAGE_SIZES;
  references?: string[];
}): Promise<OpenRouterImageResult> {
  if (!isOpenRouterImageModel(opts.model)) return { ok: false, error: "Unsupported OpenRouter image model." };
  const account = openRouterImageAccounts()[0];
  const entry = account && accounts.entries(account.id).find((item) => item.field === CHAT_FIELD);
  const key = entry && vault.read(entry.name, "studio_openrouter_image")?.trim();
  if (!key) return { ok: false, error: MISSING_IMAGE_KEY };

  try {
    const fields = {
      model: opts.model, prompt: opts.prompt, size: IMAGE_SIZES[opts.format],
      quality: "medium", output_format: "png",
    };
    const references = opts.references ?? [];
    if (references.length > 4) throw new Error("Choose up to four reference images.");
    for (const dataUrl of references) {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
      if (!match) throw new Error("Reference images must be PNG, JPEG or WebP.");
      const bytes = Buffer.from(match[2]!, "base64");
      if (!bytes.length || bytes.length > IMAGE_CAP) throw new Error("Each reference image must be under 12 MB.");
    }
    const response = await fetch(`${OPENROUTER_CHAT_BASE}/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...ATTRIBUTION },
      body: JSON.stringify({
        ...fields, n: 1,
        ...(references.length ? {
          input_references: references.map((url) => ({ type: "image_url", image_url: { url } })),
        } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const result = await boundedJson(response) as { data?: { b64_json?: unknown }[]; error?: { message?: unknown } };
    if (!response.ok) {
      const detail = typeof result.error?.message === "string" ? result.error.message : "Image generation was refused.";
      throw new Error(`OpenRouter (${response.status}): ${detail}`);
    }
    const encoded = result.data?.[0]?.b64_json;
    if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new Error("OpenRouter returned no readable image.");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > IMAGE_CAP) throw new Error("OpenRouter's image exceeded the 12 MB image limit.");
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("OpenRouter did not return a PNG image.");
    return { ok: true, bytes };
  } catch (err) {
    const message = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
      ? "OpenRouter image generation timed out. Check your OpenRouter usage before retrying; the request may still finish."
      : err instanceof SyntaxError ? "OpenRouter returned an unreadable image response."
      : err instanceof Error ? err.message : "Could not generate the image with OpenRouter.";
    return { ok: false, error: message.replaceAll(key, "[redacted]").replace(/sk-[\w-]+/g, "[redacted]").slice(0, 900) };
  }
}
