import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Bars } from "@/components/charts";
import { cn } from "@/lib/utils";
import { count, day } from "@/lib/format";
import { activityApi } from "@/lib/api/activity";

/**
 * ONE PRODUCT'S USERS — the daily chart and the table.
 *
 * THE FILTERS ARE SERVER-SIDE rather than a predicate over rows already
 * fetched, and the reason is the size this is expected to reach rather than the
 * size it starts at: the list is paged on the wire, so a product with a hundred thousand users
 * costs the same as one with three. The chips are built from the values the
 * product ACTUALLY uses — `facets` — so they fit each product instead of a
 * fixed list that fits none.
 *
 * THERE IS NO ADDRESS ON THIS PAGE AND NO WAY TO SEARCH FOR ONE. Addresses are
 * stored as a salted hash; the domain is shown because "gmail.com" identifies
 * nobody, and the search box says in as many words that it cannot match an
 * address. That is a design decision and not a missing feature.
 */

const PAGE = 100;

export function UserProduct({ product }: { product: string }) {
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState<string | null>(null);
  const [paid, setPaid] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const list = useApi(
    () =>
      activityApi.userList(product, {
        q: q || undefined,
        plan: plan ?? undefined,
        paid: paid ?? undefined,
        limit: PAGE,
        offset,
      }),
    [product, q, plan, paid, offset],
  );
  const roll = useApi(() => activityApi.users(180), []);

  const card = roll.data?.products.find(
    (p) => p.product.toLowerCase() === product.toLowerCase() || String(p.accountId) === product,
  );

  if (list.error)
    return (
      <>
        <Back />
        <p className="text-muted-foreground text-[14px]">{list.error}</p>
      </>
    );
  if (!list.data) return <p className="text-muted-foreground text-[14px]">Reading…</p>;
  const d = list.data;
  const bars = (card?.days ?? []).filter((x) => x.signups !== null);

  return (
    <>
      <Back />
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h2 className="text-[20px] font-normal tracking-[-0.025em]">{d.product}</h2>
        <span className="text-muted-foreground text-[13.5px]">
          {d.total !== null ? (
            <>
              {count(d.total)} users by the product's own count
              {d.total > d.rowsHeld && ` · ${count(d.rowsHeld)} of them listed here`}
            </>
          ) : (
            <>{count(d.rowsHeld)} rows held — the endpoint published no total, so this is a floor</>
          )}
        </span>
      </div>

      {bars.length > 1 && (
        <div className="bg-card mb-4 rounded-[14px] px-4.5 py-3.5">
          <Bars
            values={bars.map((x) => x.signups ?? 0)}
            barLabels={bars.map((x) => `${x.day} — ${x.signups} signup${x.signups === 1 ? "" : "s"}`)}
            labels="Signups per day, bucketed from each row's own createdAt — the product's timestamp, not ours."
          />
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOffset(0);
          }}
          placeholder="id, plan, country or mail domain"
          className="h-8 max-w-[280px] text-[13.5px]"
        />
        {d.facets.plans.slice(0, 8).map((p) => (
          <Chip key={p} on={plan === p} onClick={() => { setPlan(plan === p ? null : p); setOffset(0); }}>
            {p}
          </Chip>
        ))}
        {(["true", "false", "unknown"] as const).map((v) => (
          <Chip key={v} on={paid === v} onClick={() => { setPaid(paid === v ? null : v); setOffset(0); }}>
            {/* "not paying" rather than "free": a product's own plan values
                often include a plan CALLED free, and two chips reading "free"
                that filter on different columns is the kind of ambiguity a
                reader resolves by clicking one and being surprised. */}
            {v === "true" ? "paying" : v === "false" ? "not paying" : "paid not said"}
          </Chip>
        ))}
        <span className="text-muted-foreground ml-auto text-[12.5px] tabular-nums">
          {count(d.matching)} match{d.matching === 1 ? "" : "es"}
        </span>
      </div>

      <div className="overflow-x-auto rounded-[14px] bg-card">
        <table className="w-full min-w-[560px] text-[13.5px]">
          <thead>
            <tr className="text-muted-foreground border-line-soft border-b text-left text-[12px] tracking-[0.04em] uppercase">
              <th className="px-3.5 py-2 font-normal">Joined</th>
              <th className="px-3.5 py-2 font-normal">Id</th>
              <th className="px-3.5 py-2 font-normal">Mail domain</th>
              <th className="px-3.5 py-2 font-normal">Plan</th>
              <th className="px-3.5 py-2 font-normal">Paying</th>
              <th className="px-3.5 py-2 font-normal">Country</th>
              <th className="px-3.5 py-2 font-normal">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {d.users.map((u) => (
              <tr key={u.id} className="border-line-soft border-t">
                <td className="px-3.5 py-2 tabular-nums whitespace-nowrap">
                  {day(u.createdAt, { year: "2-digit" })}
                </td>
                <td className="text-muted-foreground max-w-[180px] truncate px-3.5 py-2 font-mono text-[12.5px]">
                  {u.id}
                </td>
                <td className="px-3.5 py-2">{u.emailDomain ?? <Dash />}</td>
                <td className="px-3.5 py-2">{u.plan ?? <Dash />}</td>
                <td className="px-3.5 py-2">
                  {u.paid === null ? (
                    <span className="text-muted-foreground" title="The product does not publish this field. Not “no”.">
                      not said
                    </span>
                  ) : u.paid ? (
                    "yes"
                  ) : (
                    "no"
                  )}
                </td>
                <td className="px-3.5 py-2">{u.country ?? <Dash />}</td>
                <td className="px-3.5 py-2 tabular-nums whitespace-nowrap">
                  {u.lastSeenAt ? day(u.lastSeenAt) : <Dash />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!d.users.length && (
        <p className="text-muted-foreground mt-2.5 text-[14px]">
          Nothing matches those filters. That is a fact about the filters, not about the product.
        </p>
      )}

      {(offset > 0 || d.matching > offset + d.users.length) && (
        <div className="mt-3 flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Previous
          </Button>
          <span className="text-muted-foreground text-[12.5px] tabular-nums">
            {offset + 1}–{offset + d.users.length} of {count(d.matching)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + d.users.length >= d.matching}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </Button>
        </div>
      )}

      <p className="text-muted-foreground mt-2.5 text-[12.5px] leading-relaxed">{d.filters.note}</p>
    </>
  );
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "hover:bg-accent rounded-lg border px-2.5 py-1 text-[13px]",
        on && "bg-accent border-foreground/25 font-medium",
      )}
    >
      {children}
    </button>
  );
}

function Back() {
  return (
    <Link
      to="/activity/users"
      className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-[13.5px]"
    >
      <ChevronLeft className="size-3.5" strokeWidth={1.8} />
      All products
    </Link>
  );
}
