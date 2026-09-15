import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Check, Copy, Globe2, List, LoaderCircle, Search, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DOMAIN_BULK_LIMIT, type DomainAvailability, type DomainSearchAccount, type DomainSearchPlan, type DomainSearchResult } from "../../../../shared/domainSearch";

const LABELS: Record<DomainAvailability, string> = { available: "Available", unavailable: "Unavailable", unsupported: "Not supported", unknown: "Could not check" };
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function DomainSearch() {
  const id = useId();
  const [accounts, setAccounts] = useState<DomainSearchAccount[] | null>(null);
  const [accountId, setAccountId] = useState(0);
  const [mode, setMode] = useState<"all" | "bulk">("all");
  const [name, setName] = useState("");
  const [bulk, setBulk] = useState("");
  const [error, setError] = useState("");
  const [loadingError, setLoadingError] = useState("");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<DomainSearchPlan | null>(null);
  const [results, setResults] = useState<DomainSearchResult[]>([]);
  const [filter, setFilter] = useState<"all" | DomainAvailability>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const [copied, setCopied] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<{ plan: DomainSearchPlan; account: DomainSearchAccount; offset: number } | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    call<{ accounts: DomainSearchAccount[] }>("/domains/search/accounts", { signal: abort.signal })
      .then(data => { setAccounts(data.accounts); setAccountId(data.accounts[0]?.id ?? 0); setLoadingError(""); })
      .catch(err => { if (!abort.signal.aborted) setLoadingError(err.message); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, [loadVersion]);

  function reset() { pending.current = null; setPlan(null); setResults([]); setError(""); setCopied(false); }
  async function run(resume = false) {
    const account = accounts?.find(a => a.id === accountId);
    if (!account || controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(""); setCopied(false);
    try {
      if (!resume || !pending.current) {
        setResults([]); setPlan(null); setLimit(50); setFilter("all"); setQuery("");
        const next = await call<DomainSearchPlan>("/domains/search/plan", {
          method: "POST", body: JSON.stringify({ mode, input: mode === "all" ? name : bulk }), signal: abort.signal,
        }, { notifyChange: false });
        abort.signal.throwIfAborted();
        setPlan(next); pending.current = { plan: next, account, offset: 0 };
      }
      const job = pending.current!;
      while (job.offset < job.plan.domains.length) {
        if (resume || job.offset) await pause(1250, abort.signal);
        const names = job.plan.domains.slice(job.offset, job.offset + job.account.batchSize);
        const params = new URLSearchParams({ accountId: String(job.account.id), domains: names.join(",") });
        const batch = await call<{ results: DomainSearchResult[] }>(`/domains/search/check?${params}`, { signal: abort.signal });
        abort.signal.throwIfAborted();
        setResults(previous => [...previous, ...batch.results]);
        job.offset += names.length;
      }
      pending.current = null;
    } catch (err) {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : "Search failed. Try again.");
    } finally {
      if (controller.current === abort) { controller.current = null; setBusy(false); }
    }
  }
  const available = results.filter(r => r.status === "available");
  const visible = results.filter(r => (filter === "all" || r.status === filter) && r.domain.includes(query.trim().toLowerCase()));
  const remaining = !!plan && results.length < plan.domains.length;
  const account = accounts?.find(a => a.id === accountId);
  async function copyAvailable() {
    try { await navigator.clipboard.writeText(available.map(r => r.domain).join("\n")); setCopied(true); }
    catch { setError("Could not copy. Select the domain names to copy them manually."); }
  }

  return <div className="space-y-4" data-domain-search>
    <p className="text-sm text-muted-foreground">Find a name for your next venture.</p>
    {loadingError ? <p role="alert" className="text-sm text-destructive">{loadingError} <button className="underline" onClick={() => setLoadVersion(n => n + 1)}>Retry</button></p>
      : accounts === null ? <p className="text-sm text-muted-foreground">Loading registrars…</p>
      : !accounts.length ? <p className="text-sm text-muted-foreground">Connect Dynadot or Spaceship to check availability. <Link to="/integrations" className="text-foreground underline">Connect a registrar</Link></p> : <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl bg-background p-1" role="group" aria-label="Domain search mode">
          {([['all', 'All TLDs', Globe2], ['bulk', 'Bulk', List]] as const).map(([value, label, Icon]) => <button key={value} type="button" disabled={busy} aria-pressed={mode === value}
            onClick={() => { setMode(value); reset(); }} className={cn("flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors disabled:opacity-50", mode === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}><Icon className="size-4" />{label}</button>)}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor={`${id}-registrar`}>Check with
          <select id={`${id}-registrar`} disabled={busy} value={accountId} onChange={e => { setAccountId(Number(e.target.value)); reset(); }} className="max-w-[240px] rounded-lg border bg-background px-2 py-2 text-foreground">
            {accounts.map(a => <option value={a.id} key={a.id}>{a.name}{accounts.filter(x => x.provider === a.provider).length > 1 ? ` · ${a.label}` : ""}</option>)}
          </select>
        </label>
      </div>
      <form onSubmit={e => { e.preventDefault(); void run(); }} className="space-y-2">
        <label htmlFor={`${id}-input`} className="block text-sm font-medium">{mode === "all" ? "Name to search" : "Domain names"}</label>
        <div className="flex flex-wrap items-start gap-2">
          {mode === "all" ? <input id={`${id}-input`} value={name} onChange={e => { setName(e.target.value); reset(); }} disabled={busy} maxLength={100} autoComplete="off" spellCheck={false}
            placeholder="Your name, without an extension" aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} className="min-w-0 flex-1 rounded-xl border bg-background px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            : <textarea id={`${id}-input`} value={bulk} onChange={e => { setBulk(e.target.value); reset(); }} disabled={busy} rows={5} maxLength={54_000} autoComplete="off" spellCheck={false}
              placeholder="One domain per line, including its extension" aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} className="min-w-0 w-full resize-y rounded-xl border bg-background px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />}
          <Button type="submit" disabled={busy || !(mode === "all" ? name : bulk).trim()} className="h-11 rounded-xl"><Search className="size-4" />{mode === "all" ? "Search all TLDs" : "Check domains"}</Button>
          {busy && <Button type="button" variant="outline" className="h-11 rounded-xl" onClick={() => controller.current?.abort()}><Square className="size-3" />Stop</Button>}
        </div>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">{mode === "all" ? "All extensions in IANA’s directory. Some are restricted or aren’t sold by your registrar." : `Up to ${DOMAIN_BULK_LIMIT} domains. Separate with lines, spaces or commas; duplicates are removed.`}</p>
        {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
      </form>
      {(plan || busy) && <div className="border-t pt-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs" role="status">
          {busy && <LoaderCircle className="size-3.5 motion-safe:animate-spin" />}
          <span>{plan ? `${results.length.toLocaleString()} of ${plan.domains.length.toLocaleString()} checked${busy ? "" : remaining ? " · Paused" : " · Complete"}` : "Preparing search…"}</span>
          <span className="text-ok">{available.length} available</span>
          {!busy && remaining && <Button variant="outline" size="sm" onClick={() => void run(true)}>Continue search</Button>}
          {!!available.length && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void copyAvailable()}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? "Copied" : "Copy available"}</Button>}
        </div>
        {plan && <progress className="h-1 w-full accent-[var(--foreground)]" aria-label="Domains checked" value={results.length} max={plan.domains.length} />}
        {!!results.length && <>
          <div className="flex flex-wrap gap-2">
            <select aria-label="Filter availability" value={filter} onChange={e => { setFilter(e.target.value as typeof filter); setLimit(50); }} className="rounded-lg border bg-background p-2 text-xs"><option value="all">All results</option>{Object.entries(LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
            <input aria-label="Filter domain results" value={query} onChange={e => { setQuery(e.target.value); setLimit(50); }} placeholder="Filter names or extensions…" className="min-w-0 flex-1 rounded-lg border bg-background p-2 text-xs" />
          </div>
          <div className="max-h-[420px] overflow-auto rounded-xl border">
            <table className="w-full text-left text-sm"><thead className="sticky top-0 bg-card text-xs text-muted-foreground"><tr><th className="px-3 py-2 font-medium">Domain</th><th className="px-3 py-2 font-medium">Availability</th><th className="px-3 py-2"><span className="sr-only">Registrar</span></th></tr></thead>
              <tbody>{visible.slice(0, limit).map(result => <tr key={result.domain} className="border-t">
                <td className="break-all px-3 py-3 font-medium">{result.domain}{result.premium && <span className="ml-2 text-xs font-normal text-warn">Premium</span>}</td>
                <td className={cn("px-3 py-3 text-xs", result.status === "available" ? "text-ok" : "text-muted-foreground")}><span>{LABELS[result.status]}</span>{result.note && <p className="mt-1 max-w-64 text-[11px]">{result.note}</p>}</td>
                <td className="px-3 py-3 text-right">{result.status === "available" && <a target="_blank" rel="noopener noreferrer" aria-label={`Open ${result.domain} at ${account?.name}`} className="inline-flex items-center gap-1 text-xs underline underline-offset-4"
                  href={account?.provider === "spaceship" ? `https://www.spaceship.com/domains/?query=${encodeURIComponent(result.domain)}` : `https://www.dynadot.com/domain/search?domain=${encodeURIComponent(result.domain)}`}>View<ArrowUpRight className="size-3" /></a>}</td>
              </tr>)}</tbody>
            </table>
            {!visible.length && <p className="p-4 text-sm text-muted-foreground">No matching results{busy ? " yet" : ""}.</p>}
            {visible.length > limit && <button className="w-full border-t p-3 text-xs hover:bg-accent" onClick={() => setLimit(n => n + 50)}>Show 50 more · {visible.length - limit} remaining</button>}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">Results from {account?.name}, cached for up to 5 minutes. Availability can change; confirm eligibility and price with the registrar.{plan?.catalogStale ? " Using the last saved TLD directory; its refresh failed." : ""}</p>
        </>}
      </div>}
    </>}
  </div>;
}
