import * as accounts from "../../accounts.ts";
import { parseTlds, searchLabel, bulkNames } from "./input.ts";
import { checkProvider } from "./providers.ts";
import type { DomainSearchAccount, DomainSearchPlan, DomainSearchResult } from "../../../../shared/domainSearch.ts";

export function searchAccounts(): DomainSearchAccount[] {
  return (["spaceship", "dynadot"] as const).flatMap(provider => accounts.list(provider)
    .filter(a => a.connected).map(a => ({ id: a.id, label: a.label, provider,
      name: provider === "spaceship" ? "Spaceship" : "Dynadot", batchSize: provider === "spaceship" ? 20 : 5 })));
}

let catalog: { tlds: string[]; at: number } | undefined;
let pendingCatalog: Promise<void> | undefined;
async function tldCatalog() {
  if (!catalog || Date.now() - catalog.at > 86_400_000) {
    pendingCatalog ??= (async () => {
      const res = await fetch("https://data.iana.org/TLD/tlds-alpha-by-domain.txt", { signal: AbortSignal.timeout(15_000), redirect: "error" });
      if (!res.ok) throw new Error("The TLD directory is unavailable. Try again, or check full domains in Bulk.");
      catalog = { tlds: parseTlds(await res.text()), at: Date.now() };
    })().finally(() => { pendingCatalog = undefined; });
    try { await pendingCatalog; } catch { if (!catalog) throw new Error("The TLD directory is unavailable. Try again, or check full domains in Bulk."); }
  }
  return catalog!;
}

export async function makePlan(mode: "all" | "bulk", input: string): Promise<DomainSearchPlan> {
  if (mode === "bulk") return { domains: bulkNames(input) };
  const label = searchLabel(input), list = await tldCatalog();
  return { domains: list.tlds.map(tld => `${label}.${tld}`), catalogUpdatedAt: new Date(list.at).toISOString(), catalogStale: Date.now() - list.at > 86_400_000 };
}

const cache = new Map<string, { result: DomainSearchResult; until: number }>();
const active = new Set<number>();
const nextRequest = new Map<number, number>();
export class SearchBusy extends Error {}

export async function searchBatch(accountId: number, names: string[], signal: AbortSignal): Promise<DomainSearchResult[]> {
  const choice = searchAccounts().find(a => a.id === accountId);
  if (!choice) throw new Error("Choose a connected Dynadot or Spaceship account in Integrations.");
  if (names.length > choice.batchSize) throw new Error(`This registrar accepts ${choice.batchSize} names per batch.`);
  if (active.has(accountId) || Date.now() < (nextRequest.get(accountId) ?? 0)) throw new SearchBusy("Another search is using this registrar. Try again shortly.");
  active.add(accountId);
  try {
    const time = Date.now();
    for (const [key, value] of cache) if (value.until <= time) cache.delete(key);
    const cached = new Map(names.flatMap(name => {
      const entry = cache.get(`${accountId}:${name}`);
      return entry ? [[name, entry.result] as const] : [];
    }));
    const missing = names.filter(name => !cached.has(name));
    if (missing.length) {
      signal.throwIfAborted();
      const creds = accounts.credentialed(choice.provider, ["key", "secret"], "domain_search").ready.find(a => a.account.id === accountId);
      if (!creds) throw new Error("This account is missing API credentials. Reconnect it in Integrations.");
      const results = await checkProvider(choice.provider, { key: creds.values.key!, secret: creds.values.secret! }, missing, signal);
      // Short bounded cache avoids repeated searches across tabs. Unknowns are retryable.
      for (const result of results) if (result.status !== "unknown") {
        if (cache.size >= 5000) cache.delete(cache.keys().next().value!);
        cache.set(`${accountId}:${result.domain}`, { result, until: Date.now() + 300_000 });
      }
      const returned = new Map(results.map(r => [r.domain, r]));
      return names.map(name => returned.get(name) ?? cached.get(name)!);
    }
    return names.map(name => cached.get(name)!);
  } finally {
    active.delete(accountId);
    nextRequest.set(accountId, Date.now() + 1100);
  }
}
