/**
 * THE CAROUSEL HAS NO MODEL OF ITS OWN. Planning, coding and the visual check
 * go to whatever the owner chose under Settings → Models — someone's own local
 * box serving a model nobody here has heard of, or a hosted router — and the
 * vision probe asks THAT model whether it can see. A model that cannot leaves
 * the slides unverified. Nothing here reaches a network: `fetch` is replaced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { models } from "../../routes/models.ts";
import { registerProvider, type ProviderId } from "../../models/provider.ts";
import { capability } from "../seoops/vision.ts";
import { carouselRoutes } from "./carousel-routes.ts";

type ModelInfo = { label: string | null; model: string | null; vision: { supports: boolean | null } };

test("the carousel's model is the workspace choice, and so is the one asked whether it can see", async () => {
  const original = globalThis.fetch;
  const sent: { url: string; model: string; image: boolean }[] = [];
  /* The owner's own box takes pictures; the hosted text model refuses them. */
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: unknown }[] };
    const image = JSON.stringify(body.messages).includes("image_url");
    sent.push({ url: String(url), model: body.model, image });
    if (image && body.model === "text-only-model")
      return Response.json({ error: { message: "This model does not support image input" } }, { status: 400 });
    return Response.json({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], model: body.model });
  };
  const provider = (id: ProviderId, model: string) =>
    registerProvider(id, () => ({
      id,
      label: `Label ${id}`,
      defaultModel: model,
      endpoints: [{ baseUrl: `https://${id}.invalid/v1`, key: null, label: "Test" }],
      policy: { mode: "parallel", concurrency: 4, balance: "round-robin", timeoutMs: 1000 },
    }));
  const choose = async (id: ProviderId) =>
    assert.equal(
      (await models.request("/provider", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: id }) })).status,
      200,
    );
  try {
    provider("local", "someones-own-vl-model");
    provider("openrouter", "text-only-model");

    await choose("local");
    const seen = await capability();
    assert.equal(seen.supports, true);
    assert.equal(sent.at(-1)!.url, "https://local.invalid/v1/chat/completions");
    assert.equal(sent.at(-1)!.model, "someones-own-vl-model");
    let info = (await (await carouselRoutes.request("/model")).json()) as ModelInfo;
    assert.deepEqual([info.label, info.model, info.vision.supports], ["Label local", "someones-own-vl-model", true]);

    await choose("openrouter");
    info = (await (await carouselRoutes.request("/model")).json()) as ModelInfo;
    /* Never asked yet: not a yes, not a no. */
    assert.equal(info.vision.supports, null);
    const blind = await capability();
    assert.equal(blind.supports, false);
    assert.equal(sent.at(-1)!.url, "https://openrouter.invalid/v1/chat/completions");
    info = (await (await carouselRoutes.request("/model")).json()) as ModelInfo;
    assert.deepEqual([info.label, info.model, info.vision.supports], ["Label openrouter", "text-only-model", false]);
  } finally {
    globalThis.fetch = original;
  }
});

test("no carousel model call names a provider or a model of its own", () => {
  const src = readFileSync(resolve(import.meta.dirname, "carousel.ts"), "utf8");
  /* Every options object handed to `complete(` in the pipeline starts with
     the venture; what follows must never pick a provider or a model. */
  const calls = [...src.matchAll(/complete\([^;]*?\{\s*(venture:[^}]*)\}/g)].map((m) => m[1]!);
  assert.ok(calls.length >= 3, "the plan, code and verify calls were found");
  for (const opts of calls) assert.doesNotMatch(opts, /\b(provider|model)\s*:/);
  assert.doesNotMatch(src, /["'`](qwen|llama|gpt-|claude|gemini)[^"'`]*["'`]/i);
});
