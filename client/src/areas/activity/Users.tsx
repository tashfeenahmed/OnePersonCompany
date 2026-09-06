import { Link } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { Bars } from "@/components/charts";
import { cn } from "@/lib/utils";
import { ago, num } from "@/components/integrations/format";
import { activityApi, type UserProduct } from "@/lib/api/activity";

/**
 * THE USERS ROLL-UP — one card per product.
 *
 * THREE THINGS THIS PAGE REFUSES TO DRAW AS A ZERO, and they are the whole
 * reason it is not a table of numbers:
 *
 *   A COUNTS-ONLY PRODUCT HAS NO SEVEN-DAY WINDOW. It publishes a total and
 *   cannot list anybody, so there are no rows to bucket by day. Those cards
 *   print an em dash and the product's OWN window ("12 new in 7 days") in its
 *   own words, because a 0 would read as "nobody signed up".
 *
 *   `paid` IS THREE-VALUED. A product that does not publish the field has an
 *   unknown paid count and its card says so beside the number, so nobody
 *   divides by a denominator that is partly guesswork.
 *
 *   THE TOTAL IS THE PRODUCT'S OWN. Where it is larger than the rows this box
 *   holds — a paged endpoint — the card says "n of N listed" rather than
 *   reporting the smaller figure or reconciling them.
 */

function Card({ p }: { p: UserProduct }) {
  const countsOnly = p.shape === "counts";
  const bars = p.days.filter((d) => d.signups !== null);

  return (
    <div className="bg-card rounded-[10px] border px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            p.reachable === true ? "bg-ok" : p.reachable === false ? "bg-destructive" : "bg-border",
          )}
        />
        <Link
          to={countsOnly ? "#" : `/activity/users/${encodeURIComponent(p.product)}`}
          className={cn("text-[13.5px] font-medium", countsOnly ? "pointer-events-none" : "hover:underline")}
        >
          {p.product}
        </Link>
        {countsOnly && (
          <Badge variant="secondary" className="font-normal" title="This endpoint publishes a total and cannot list its users.">
            counts only
          </Badge>
        )}
        {p.venture && (
          <Link
            to={`/ventures/${p.venture.slug}`}
            className="text-muted-foreground text-[11.5px] hover:underline"
            title={
              p.venture.matchedBy === "host"
                ? "Filed by a hostname that looked alike — a guess. Set it in the plugin's settings to make it a decision."
                : `Filed by ${p.venture.matchedBy === "setting" ? "the setting" : "a link on the venture map"}.`
            }
          >
            {p.venture.name}
            {p.venture.matchedBy === "host" && " ?"}
          </Link>
        )}
        <span className="text-muted-foreground ml-auto shrink-0 text-[11.5px]">
          {ago(p.lastFetchedAt)}
        </span>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-2">
        <Figure
          v={num(p.total ?? (p.rowsHeld || null))}
          k={p.total !== null ? "users (their count)" : "user rows held"}
          note={
            p.partialList
              ? `${num(p.rowsHeld)} of them listed here`
              : p.total === null && p.rowsHeld > 0
                ? "a floor — the endpoint published no total"
                : undefined
          }
        />
        <Figure
          v={countsOnly ? "—" : num(p.new7d)}
          k="new · 7d"
          note={countsOnly ? "no rows to bucket" : undefined}
        />
        <Figure
          v={countsOnly ? "—" : num(p.new30d)}
          k="new · 30d"
          note={countsOnly ? "no rows to bucket" : "never added to the 7d"}
        />
        <Figure
          v={countsOnly ? "—" : num(p.paid)}
          k="paying"
          note={
            countsOnly
              ? "not published"
              : p.paidUnknown
                ? `${num(p.paidUnknown)} not said`
                : undefined
          }
        />
      </div>

      {countsOnly && p.newWindow && (
        <p className="text-muted-foreground mt-2 text-[12px]">
          Its own window: {num(p.newWindow.n)} new in {p.newWindow.days} days — the only one it
          publishes, quoted in its words.
        </p>
      )}

      {!countsOnly && bars.length > 1 && (
        <Bars
          values={bars.map((d) => d.signups ?? 0)}
          barLabels={bars.map((d) => `${d.day} — ${d.signups} signup${d.signups === 1 ? "" : "s"}`)}
          labels={`Signups per day, from the rows held. ${bars.length} day(s) with any.`}
        />
      )}

      {p.error && <p className="text-destructive mt-2 text-[11.5px]">{p.error}</p>}
      {p.reachable === null && !p.error && (
        <p className="text-muted-foreground mt-2 text-[12px]">
          Never collected. That is not a failure — nothing has asked yet.
        </p>
      )}
      {!!p.problems.length && (
        <div className="mt-2 flex flex-col gap-0.5">
          {p.problems.slice(0, 4).map((why, i) => (
            <p key={i} className="text-destructive text-[11.5px]">
              {why}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function Figure({ v, k, note }: { v: string; k: string; note?: string }) {
  return (
    <div>
      <div className="text-[19px] font-normal tracking-[-0.03em] tabular-nums">{v}</div>
      <div className="text-muted-foreground mt-0.5 text-[11.5px]">{k}</div>
      {note && <div className="text-muted-foreground text-[11px]">{note}</div>}
    </div>
  );
}

export function Users() {
  const report = useApi(() => activityApi.users(90), []);

  if (report.error)
    return <p className="text-muted-foreground text-[13px]">The API is not answering: {report.error}</p>;
  if (!report.data) return <p className="text-muted-foreground text-[13px]">Reading…</p>;
  const d = report.data;

  if (!d.products.length)
    return (
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        No product is publishing its users yet. Connect one under Integrations → App users: it takes
        a URL that answers either a list of users or a bare count, and the contract is on that page.
      </p>
    );

  const s = d.summary;
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="bg-card min-w-[132px] flex-1 rounded-[10px] border px-3.5 py-3">
          <div className="text-[19px] font-normal tracking-[-0.03em] tabular-nums">
            {num(s.totalUsers)}
          </div>
          <div className="text-muted-foreground mt-0.5 text-[11.5px]">
            users across {s.configured} product{s.configured === 1 ? "" : "s"}
          </div>
          {s.complete === false && (
            <div className="text-muted-foreground text-[11px]">a floor — not every one answered</div>
          )}
        </div>
        <div className="bg-card min-w-[132px] flex-1 rounded-[10px] border px-3.5 py-3">
          <div className="text-[19px] font-normal tracking-[-0.03em] tabular-nums">{num(s.new7d)}</div>
          <div className="text-muted-foreground mt-0.5 text-[11.5px]">new in 7 days</div>
          {s.windowsMissing > 0 && (
            <div className="text-muted-foreground text-[11px]">
              {s.windowsMissing} product{s.windowsMissing === 1 ? "" : "s"} absent, not zero
            </div>
          )}
        </div>
        <div className="bg-card min-w-[132px] flex-1 rounded-[10px] border px-3.5 py-3">
          <div className="text-[19px] font-normal tracking-[-0.03em] tabular-nums">{num(s.new30d)}</div>
          <div className="text-muted-foreground mt-0.5 text-[11.5px]">new in 30 days</div>
          <div className="text-muted-foreground text-[11px]">contains the 7d — never added to it</div>
        </div>
        <div className="bg-card min-w-[132px] flex-1 rounded-[10px] border px-3.5 py-3">
          <div className="text-[19px] font-normal tracking-[-0.03em] tabular-nums">
            {s.answering}/{s.configured}
          </div>
          <div className="text-muted-foreground mt-0.5 text-[11.5px]">endpoints answering</div>
          {s.countsOnly > 0 && (
            <div className="text-muted-foreground text-[11px]">{s.countsOnly} counts-only</div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {d.products.map((p) => (
          <Card key={p.accountId} p={p} />
        ))}
      </div>

      <p className="text-muted-foreground mt-2.5 text-[11.5px] leading-relaxed">{s.note}</p>
    </>
  );
}
