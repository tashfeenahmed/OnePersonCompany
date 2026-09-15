import { Hono } from "hono";
import { bulkNames } from "./input.ts";
import { makePlan, searchAccounts, searchBatch, SearchBusy } from "./service.ts";

export const domainSearch = new Hono();
domainSearch.get("/accounts", c => c.json({ accounts: searchAccounts() }));
// POST carries bulk lists without URL length limits. This only prepares names.
domainSearch.post("/plan", async c => {
  const raw = await c.req.text();
  if (raw.length > 60_000) return c.json({ error: "Search input is too large." }, 413);
  const body: unknown = await Promise.resolve().then(() => JSON.parse(raw)).catch(() => null);
  if (!body || typeof body !== "object" || !("input" in body) || !("mode" in body)) return c.json({ error: "Enter names to check." }, 400);
  const { input, mode } = body;
  if (typeof input !== "string" || !input || input.length > 54_000 || (mode !== "all" && mode !== "bulk")) return c.json({ error: "Choose All TLDs or Bulk and enter names to check." }, 400);
  try { return c.json(await makePlan(mode, input)); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "Could not prepare the search." }, 400); }
});
domainSearch.get("/check", async c => {
  c.header("Cache-Control", "no-store");
  const id = Number(c.req.query("accountId")), input = c.req.query("domains") ?? "";
  if (!Number.isInteger(id) || id < 1 || input.length > 5200) return c.json({ error: "Choose a registrar and valid domain names." }, 400);
  let names: string[];
  try { names = bulkNames(input, 20); }
  catch (error) { return c.json({ error: (error as Error).message }, 400); }
  try { return c.json({ results: await searchBatch(id, names, c.req.raw.signal) }); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "Search failed." }, error instanceof SearchBusy ? 429 : 502); }
});
