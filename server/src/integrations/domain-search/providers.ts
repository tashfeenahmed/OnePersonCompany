import { signature } from "../../providers/dynadot.ts";
import type { DomainSearchResult } from "../../../../shared/domainSearch.ts";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const bool = (value: unknown): boolean | null => value === true || /^(yes|true)$/i.test(String(value)) ? true
  : value === false || /^(no|false)$/i.test(String(value)) ? false : null;

/** Only an explicit registrar answer establishes availability. Missing rows,
 * low-confidence caches, reserved names and errors never turn into “available”. */
export function parseResults(provider: "spaceship" | "dynadot", doc: unknown, names: string[], checkedAt: string): DomainSearchResult[] {
  const root = object(doc), data = object(root.data);
  const raw = provider === "spaceship" ? root.domains : data.domain_result_list;
  if (!Array.isArray(raw)) throw new Error("The registrar returned an unreadable response. Try again.");
  const rows = new Map(raw.map(value => {
    const row = object(value);
    return [String(row.domain ?? row.domain_name ?? "").toLowerCase(), row];
  }));
  return names.map(domain => {
    const row = rows.get(domain);
    const base = { domain, checkedAt, premium: null } ;
    if (!row) return { ...base, status: "unknown", note: "No answer returned for this domain." };
    if (provider === "spaceship") {
      const state = String(row.result ?? "").toLowerCase();
      const status = state === "available" ? "available" : ["taken", "unavailable", "reserved", "reservedbyregistry"].includes(state.replace(/[_ -]/g, "")) ? "unavailable"
        : ["unsupported", "tldnotsupported", "notsupported"].includes(state.replace(/[_ -]/g, "")) ? "unsupported" : "unknown";
      return { ...base, status, premium: Array.isArray(row.premiumPricing) && row.premiumPricing.length ? true : null,
        ...(status === "unknown" ? { note: "The registrar could not determine availability." } : {}) };
    }
    const error = String(row.details_error_message ?? "");
    if (error || String(row.confidence).toLowerCase() === "low") return { ...base,
      status: /unsupported|not supported/i.test(error) ? "unsupported" : "unknown",
      note: error ? "The registrar could not check this domain." : "The registrar returned a low-confidence answer." };
    const available = bool(row.available);
    return { ...base, status: available === true ? "available" : available === false ? "unavailable" : "unknown",
      premium: bool(row.premium), ...(available === null ? { note: "Availability was not reported." } : {}) };
  });
}

/** Read-only search endpoints, documented by the providers:
 * https://docs.spaceship.dev/#tag/Domain-Availability
 * https://www.dynadot.com/domain/api-document#bulk_search
 * Dynadot regular-tier accounts accept five names per request. */
export async function checkProvider(provider: "spaceship" | "dynadot", credentials: {key: string; secret: string}, names: string[], signal: AbortSignal): Promise<DomainSearchResult[]> {
  const { key, secret } = credentials;
  let url: string, init: RequestInit;
  if (provider === "spaceship") {
    url = "https://spaceship.dev/api/v1/domains/available";
    init = { method: "POST", headers: { "X-API-Key": key, "X-API-Secret": secret, "Content-Type": "application/json", "User-Agent": "onepersoncompany/1.0" }, body: JSON.stringify({ domains: names }) };
  } else {
    const query = new URLSearchParams({ domain_name_list: names.join(","), show_price: "true", currency: "USD", timeout: "15" });
    const path = `/restful/v2/domains/bulk_search?${query}`;
    url = "https://api.dynadot.com" + path;
    init = { headers: { Authorization: `Bearer ${key}`, "X-Signature": signature(key, secret, path), Accept: "application/json" } };
  }
  let res: Response;
  try { res = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: "error" }); }
  catch { signal.throwIfAborted(); throw new Error("The registrar did not respond. Your completed results are kept; try again shortly."); }
  const doc: unknown = await res.json().catch(() => null);
  const status = Number(object(doc).code ?? res.status);
  if (!res.ok || status !== 200) {
    // Never echo provider bodies: they can contain credentials or request URLs.
    if ([401, 403].includes(res.status) || [401, 403].includes(status)) throw new Error("Search access was refused. Check this account’s API permissions and IP allowlist in Integrations, or choose another registrar.");
    if (res.status === 429 || status === 429) throw new Error("The registrar’s search limit was reached. Completed results are kept; try again later.");
    throw new Error(`The registrar could not check this batch (HTTP ${res.status === 200 ? status : res.status}). Try another registrar or retry later.`);
  }
  return parseResults(provider, doc, names, new Date().toISOString());
}
