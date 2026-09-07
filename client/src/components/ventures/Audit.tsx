import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import type { Venture } from "@/lib/api";
import { ventureApi, type Audit as AuditDoc, type AuditFinding } from "@/lib/api/ventures";
import { cn } from "@/lib/utils";

/**
 * WHAT IS WRONG WITH THIS SITE, WITH THE EVIDENCE ATTACHED.
 *
 * THERE IS NO SCORE AND THERE WILL NOT BE ONE. A number out of a hundred hides
 * which of its inputs moved: a site that went from 74 to 68 tells you nothing
 * you can act on, and every finding here already names the pages it is about
 * and the test that produced it. The server says so in its own sentence and it
 * is printed rather than paraphrased.
 *
 * THE CRAWL IS A SURVEY, NOT AN INDEX. Sixty pages from the home page
 * outwards, obeying robots, with a two-minute ceiling — so "nothing wrong
 * here" means nothing wrong in what was reached. Every count on this page is
 * read beside `pages`, and the Search Console join says out loud how many
 * ranked pages the crawl never got to. A page that says "0 errors" over a
 * crawl that reached four pages is the lie this layout is arranged to avoid.
 *
 * RUNNING ONE TAKES A MINUTE OR TWO and the request is held open for all of
 * it. So the press starts the POST and ALSO polls the stored document: if the
 * long request is dropped by something in between, the crawl still finished on
 * the server and the poll finds it. Whichever arrives first with a timestamp
 * that is not the old one wins.
 */
const POLL_MS = 6_000;

export function Audit({ venture }: { venture: Venture }) {
  const { data, error, loading, setData, reload } = useApi(
    () => ventureApi.audit(venture.slug),
    [venture.slug],
  );
  const history = useApi(() => ventureApi.auditHistory(venture.slug), [venture.slug]);
  const [running, setRunning] = useState(false);
  const [since, setSince] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const stop = useRef(false);

  /* A seconds counter rather than a bar: nothing on the wire reports progress
     through a crawl, and a bar that moves on a timer is a bar that is making
     it up. */
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setSince((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  useEffect(() => () => void (stop.current = true), []);

  async function run() {
    const was = data?.ts ?? null;
    setRunning(true);
    setSince(0);
    setFailed(null);
    stop.current = false;

    const poll = async () => {
      while (!stop.current) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (stop.current) return null;
        try {
          const doc = await ventureApi.audit(venture.slug);
          if (doc.ts !== was) return doc;
        } catch {
          /* A 404 while nothing has ever been stored is the ordinary state
             here, not a failure worth reporting on top of the run. */
        }
      }
      return null;
    };

    try {
      const doc = await Promise.race([
        ventureApi.runAudit(venture.slug),
        poll(),
      ]);
      if (doc) setData(doc);
      else reload();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      reload();
    } finally {
      stop.current = true;
      setRunning(false);
      history.reload();
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-16">
      <div className="mx-auto flex w-full max-w-[940px] flex-col gap-6">
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[14px] font-medium">SEO audit</h2>
            {data && (
              <span className="text-muted-foreground text-[12.5px]">
                {new Date(data.ts).toLocaleString()}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={running || !venture.website}
              onClick={() => void run()}
            >
              <Play className="size-3.5" strokeWidth={1.6} />
              {running ? "Crawling…" : data ? "Run again" : "Run audit"}
            </Button>
          </div>

          {!venture.website && (
            <p className="text-muted-foreground text-[13.5px]">
              {venture.name} has no website, so there is nothing to crawl.
            </p>
          )}

          {running && (
            <p className="text-muted-foreground text-[13.5px] leading-snug">
              Crawling {venture.host ?? venture.website} — {since}s so far. It
              fetches up to {data?.limits.pages ?? 60} pages from the home page
              outwards with a pause between each, so a minute or two is normal.
              Leaving this tab does not stop it; the finished audit is stored
              and will be here when you come back.
            </p>
          )}

          {failed && !running && (
            <p className="text-destructive text-[13.5px]">{failed}</p>
          )}

          {/* The 404 for "never audited" carries the server's own sentence,
              which already says what to press. It is shown as the state it is
              rather than as an error. */}
          {!data && !running && error && (
            <p className="text-muted-foreground text-[13.5px]">{error}</p>
          )}
          {!data && !running && !error && loading && (
            <p className="text-muted-foreground text-[13.5px]">
              Reading the last audit…
            </p>
          )}
        </section>

        {data && (
          <>
            <Summary doc={data} />
            <SiteChecks doc={data} />
            <Findings doc={data} />
            <SearchJoin doc={data} />
          </>
        )}

        {/* --------------------------------------------------- history */}
        <section>
          <h2 className="mb-2 text-[14px] font-medium">Every run</h2>
          {history.data?.runs.length ? (
            <>
              <p className="text-muted-foreground mb-2 text-[12.5px] leading-snug">
                {history.data.note}
              </p>
              <div className="flex flex-col gap-px">
                {history.data.runs.map((r) => (
                  <div
                    key={r.id}
                    className={cn(
                      "flex items-baseline gap-3 py-1 text-[13.5px]",
                      data && r.ts === data.ts && "font-medium",
                    )}
                  >
                    <span className="w-[168px] shrink-0">
                      {new Date(r.ts).toLocaleString()}
                    </span>
                    <span className="text-muted-foreground text-[12.5px]">
                      {r.pages} pages
                    </span>
                    <span className="text-muted-foreground text-[12.5px]">
                      {r.issues} {r.issues === 1 ? "issue" : "issues"}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-[13.5px]">
              {history.error ?? "Nothing has been run yet."}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ parts */

function Summary({ doc }: { doc: AuditDoc }) {
  return (
    <section>
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
        <Stat label="Pages reached" value={doc.summary.pages} />
        <Stat label="Errors" value={doc.summary.errors} tone="bad" />
        <Stat label="Warnings" value={doc.summary.warnings} tone="warn" />
        <Stat label="Notices" value={doc.summary.notices} />
      </div>
      <p className="text-muted-foreground mt-2 text-[12.5px] leading-snug">
        {doc.summary.scoreNote}
      </p>
      <p className="text-muted-foreground mt-1 text-[12.5px] leading-snug">
        {doc.crawl.stoppedBecause === "the site was crawled to its end"
          ? `The crawl reached the end of the site: ${doc.crawl.reached} pages in ${Math.round(doc.crawl.ms / 1000)}s.`
          : `The crawl stopped because ${doc.crawl.stoppedBecause} — ${doc.crawl.reached} pages reached, ${doc.crawl.queuedButNotReached} found and not fetched. Every count below is about the pages that were reached.`}
        {doc.crawl.blockedByRobots.length > 0 &&
          ` ${doc.crawl.blockedByRobots.length} ${doc.crawl.blockedByRobots.length === 1 ? "URL was" : "URLs were"} left alone because robots.txt says so.`}
      </p>
    </section>
  );
}

function SiteChecks({ doc }: { doc: AuditDoc }) {
  return (
    <section>
      <h2 className="mb-2 text-[14px] font-medium">The site itself</h2>
      <p className="text-muted-foreground mb-2 text-[12.5px]">
        Four checks that are about the whole site rather than about a page.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Check
          title="robots.txt"
          state={doc.robots.present ? "ok" : "warn"}
          head={
            doc.robots.present
              ? `Served, HTTP ${doc.robots.status ?? "—"} · ${doc.robots.rules.length} ${doc.robots.rules.length === 1 ? "rule" : "rules"} for “${doc.robots.agent ?? "*"}”`
              : "No robots.txt. Not a fault — everything is allowed by default."
          }
          note={doc.robots.note}
        >
          {doc.robots.sitemaps.length > 0 && (
            <div className="text-muted-foreground text-[12.5px]">
              Names {doc.robots.sitemaps.length}{" "}
              {doc.robots.sitemaps.length === 1 ? "sitemap" : "sitemaps"}
            </div>
          )}
        </Check>

        <Check
          title="Sitemap"
          state={doc.sitemap.found ? "ok" : "warn"}
          head={
            doc.sitemap.found
              ? `${doc.sitemap.found} · ${doc.sitemap.urls ?? "an unknown number of"} URLs`
              : `Not found. ${doc.sitemap.checked.length} ${doc.sitemap.checked.length === 1 ? "address was" : "addresses were"} tried.`
          }
          note={doc.sitemap.note}
        />

        <Check
          title="HTTPS"
          state={
            doc.https.httpRedirectsToHttps === true
              ? "ok"
              : doc.https.httpRedirectsToHttps === false
                ? "bad"
                : "unknown"
          }
          head={
            doc.https.httpRedirectsToHttps === null
              ? "Could not be tested."
              : doc.https.httpRedirectsToHttps
                ? "http redirects to https."
                : "http does not redirect to https."
          }
          note={doc.https.note}
        />

        <Check
          title="Canonical host"
          state={
            doc.canonicalHost.answered === null
              ? "unknown"
              : doc.canonicalHost.answered.replace(/\/$/, "") ===
                  doc.canonicalHost.requested.replace(/\/$/, "")
                ? "ok"
                : "warn"
          }
          head={
            doc.canonicalHost.answered
              ? `${doc.canonicalHost.requested} → ${doc.canonicalHost.answered}`
              : `${doc.canonicalHost.requested} did not answer.`
          }
          note={doc.canonicalHost.note}
        />
      </div>

      {doc.links.broken.length > 0 && (
        <div className="mt-3">
          <h3 className="mb-1 text-[13.5px] font-medium">
            Broken links · {doc.links.broken.length}
          </h3>
          <p className="text-muted-foreground mb-1.5 text-[12.5px]">
            {doc.links.note}
          </p>
          <div className="flex flex-col gap-px">
            {doc.links.broken.map((b) => (
              <div key={b.url} className="flex items-baseline gap-2 text-[13.5px]">
                <span className="text-destructive w-[42px] shrink-0 text-[12.5px]">
                  {b.status || "—"}
                </span>
                <PageLink url={b.url} />
                <span className="text-muted-foreground shrink-0 text-[12px]">
                  from {b.linkedFrom.length}{" "}
                  {b.linkedFrom.length === 1 ? "page" : "pages"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Findings({ doc }: { doc: AuditDoc }) {
  const groups = [
    { key: "error" as const, label: "Errors", rows: doc.bySeverity.error },
    { key: "warning" as const, label: "Warnings", rows: doc.bySeverity.warning },
    { key: "notice" as const, label: "Notices", rows: doc.bySeverity.notice },
  ].filter((g) => g.rows.length);

  if (!groups.length)
    return (
      <section>
        <h2 className="mb-2 text-[14px] font-medium">Findings</h2>
        <p className="text-muted-foreground text-[13.5px] leading-snug">
          Nothing was found wrong with the {doc.summary.pages} pages this crawl
          reached. That is not the same as a clean site: pages further in than
          the crawl went were never looked at.
        </p>
      </section>
    );

  return (
    <section>
      <h2 className="mb-2 text-[14px] font-medium">Findings</h2>
      <div className="flex flex-col gap-4">
        {groups.map((g) => (
          <div key={g.key}>
            <div className="mb-1.5 flex items-center gap-2">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  g.key === "error" && "bg-destructive",
                  g.key === "warning" && "bg-warn",
                  g.key === "notice" && "bg-border",
                )}
              />
              <h3 className="text-[13.5px] font-medium">{g.label}</h3>
              <span className="text-muted-foreground text-[12.5px]">
                {g.rows.reduce((n, f) => n + f.count, 0)} across {g.rows.length}{" "}
                {g.rows.length === 1 ? "check" : "checks"}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {g.rows.map((f) => (
                <FindingRow key={f.code} finding={f} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function FindingRow({ finding }: { finding: AuditFinding }) {
  const [open, setOpen] = useState(false);
  const shown = open ? finding.pages : finding.pages.slice(0, 4);
  return (
    <div className="rounded-[14px] bg-card px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[13.5px]">{finding.what}</span>
        <span className="text-muted-foreground ml-auto shrink-0 text-[12.5px]">
          {finding.count} {finding.count === 1 ? "page" : "pages"}
        </span>
      </div>
      {/* What the verdict was computed from, so it can be argued with. */}
      <p className="text-muted-foreground mt-1 text-[12.5px] leading-snug">
        {finding.evidence}
      </p>
      <div className="mt-1.5 flex flex-col gap-px">
        {shown.map((p) => (
          <PageLink key={p} url={p} />
        ))}
        {finding.pages.length > 4 && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-muted-foreground hover:text-foreground w-fit text-[12.5px]"
          >
            {open ? "Fewer" : `${finding.pages.length - 4} more`}
          </button>
        )}
        {finding.count > finding.pages.length && (
          <span className="text-muted-foreground text-[12px]">
            {finding.count - finding.pages.length} more pages are counted here
            and not listed — the list is capped so one bad template does not
            print sixty URLs.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * THE ONE JOIN ON THIS PAGE. A crawl finds faults; Search Console knows which
 * pages anybody actually sees. Together they say which fault is worth the
 * afternoon — and the server's note is printed WORD FOR WORD because most of
 * what it says is about what is NOT here.
 */
function SearchJoin({ doc }: { doc: AuditDoc }) {
  return (
    <section>
      <h2 className="mb-2 text-[14px] font-medium">
        Against what Google actually shows
      </h2>
      <p className="text-muted-foreground mb-2 text-[12.5px] leading-snug">
        {doc.search.note}
      </p>
      {doc.search.ranked.length > 0 && (
        <div className="flex flex-col gap-px">
          {doc.search.ranked.map((r) => (
            <div key={r.page} className="flex items-baseline gap-3 py-1 text-[13.5px]">
              <PageLink url={r.page} />
              <span className="text-muted-foreground ml-auto shrink-0 text-[12.5px]">
                {r.impressions.toLocaleString()} impressions
              </span>
              <span className="text-muted-foreground shrink-0 text-[12.5px]">
                {r.clicks.toLocaleString()} clicks
              </span>
              <span className="text-muted-foreground w-[52px] shrink-0 text-right text-[12.5px]">
                {r.position === null ? "unranked" : `#${r.position}`}
              </span>
              <span className="text-muted-foreground w-[150px] shrink-0 truncate text-[12px]">
                {r.issues.join(", ")}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ chrome */

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "bad" | "warn";
}) {
  return (
    <div className="rounded-[14px] bg-card px-3 py-2.5">
      <div
        className={cn(
          "text-[20px] leading-tight tracking-tight",
          value > 0 && tone === "bad" && "text-destructive",
          value > 0 && tone === "warn" && "text-warn",
        )}
      >
        {value.toLocaleString()}
      </div>
      <div className="text-muted-foreground mt-0.5 text-[12.5px]">{label}</div>
    </div>
  );
}

function Check({
  title,
  state,
  head,
  note,
  children,
}: {
  title: string;
  state: "ok" | "warn" | "bad" | "unknown";
  head: string;
  note: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-[14px] bg-card p-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 rounded-full",
            state === "ok" && "bg-ok",
            state === "warn" && "bg-warn",
            state === "bad" && "bg-destructive",
            state === "unknown" && "bg-border",
          )}
        />
        <span className="text-[13.5px] font-medium">{title}</span>
      </div>
      <div className="mt-1 text-[13.5px] break-words">{head}</div>
      {children}
      {note && (
        <p className="text-muted-foreground mt-1 text-[12.5px] leading-snug">
          {note}
        </p>
      )}
    </div>
  );
}

/** A page the crawl reached, as a link to the real thing. The origin is
 *  dropped: sixty rows that all start with the same https://host are sixty
 *  rows whose first thirty characters carry no information. */
function PageLink({ url }: { url: string }) {
  let shown = url;
  try {
    const u = new URL(url);
    shown = `${u.pathname}${u.search}` || "/";
  } catch {
    /* Not a URL this browser can parse — show it whole rather than guess. */
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={url}
      className="text-muted-foreground hover:text-foreground min-w-0 truncate text-[12.5px]"
    >
      {shown}
    </a>
  );
}
