import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { integrations } from "@/lib/api/integrations";
import { cn } from "@/lib/utils";
import { ago, count } from "./format";
import { EntityLinks } from "./EntityLinks";
import { Note, PanelEmpty, PanelSection, Row, Rows, Tiles } from "./Panel";
import { activityApi } from "@/lib/api/activity";

/**
 * THE USERS PLUGIN'S OWN PAGE.
 *
 * Three things, in the order somebody debugging an endpoint needs them:
 *
 *   THE CONTRACT, written out in full, because the most common failure here is
 *   an endpoint that returns a perfectly good document of the wrong shape — and
 *   the fix is a five-minute edit to a handler the owner already has open.
 *
 *   WHAT VALIDATION SAID, per product, in the validator's own sentences. Those
 *   name the field and show the value: "users[3].createdAt is "yesterday",
 *   which is not an ISO 8601 timestamp". Anything shorter sends the reader to
 *   read their own JSON by hand.
 *
 *   THE LAST DOCUMENT, with every address stripped out before it was stored.
 *   A reader needs the SHAPE to check a contract error against — is it
 *   `created_at` here? — and a debugging aid is not a reason to keep thousands
 *   of real addresses in the one table built to avoid holding them.
 *
 * A FAILING ENDPOINT STILL SHOWS ITS FIGURES, dated, beside the reason. A
 * document that fails validation changes nothing: the rows the last good one
 * produced are exactly as they were.
 */

const CONTRACT = `{
  "users": [
    { "id": "u_1",
      "createdAt": "2026-08-01T09:00:00Z",
      "email": "mary@example.com",
      "plan": "pro",
      "paid": true,
      "lastSeenAt": "2026-09-01T14:20:00Z",
      "country": "IE" }
  ],
  "total": 4873,
  "generatedAt": "2026-09-05T19:00:00Z"
}

// or, for a product that cannot list its users at all:

{ "counts": { "total": 158, "new": { "days": 7, "n": 12 } },
  "generatedAt": "2026-09-05T19:00:00Z" }`;

export function UsersPanel({ onCollected }: { onCollected?: () => void }) {
  const report = useApi(() => activityApi.users(30), []);
  const map = useApi(() => integrations.ventureMap(), []);
  const [collecting, setCollecting] = useState(false);
  const [openDoc, setOpenDoc] = useState<number | null>(null);

  async function collect() {
    setCollecting(true);
    try {
      await api.collect("users");
      report.reload();
      onCollected?.();
    } finally {
      setCollecting(false);
    }
  }

  if (report.error || !report.data) return null;
  const d = report.data;

  return (
    <>
      <PanelSection title="The contract">
        <pre className="bg-accent/40 overflow-x-auto rounded-[10px] border px-3.5 py-3 font-mono text-[11.5px] leading-relaxed">
          {CONTRACT}
        </pre>
        <Note>
          `id` and `createdAt` are the only required fields on a user, and
          `createdAt` has to be ISO 8601 — that timestamp is the one this box
          treats as a measurement rather than a collection. The second form
          exists because an empty list and a product that cannot name its users
          are OPPOSITE facts: an empty <code>users</code> array says nobody
          signed up, <code>counts</code> says it has some and cannot list them.
          Addresses are hashed
          with a salt made once on this install and only the domain is kept
          readable; there is no route here that takes or returns an address.
        </Note>
      </PanelSection>

      {!d.products.length ? (
        <PanelEmpty>
          No product endpoint is connected yet. Add one above as the URL of
          something that answers the document at the top of this page.
        </PanelEmpty>
      ) : (
        <PanelSection
          title="What it reads"
          meta={`fetched ${ago(d.summary.lastFetchedAt)}`}
          onCollect={() => void collect()}
          collecting={collecting}
        >
          <Tiles
            items={[
              { v: `${d.summary.answering}/${d.summary.configured}`, k: "endpoints answering" },
              { v: String(d.summary.failing), k: "refusing or invalid" },
              { v: count(d.summary.totalUsers), k: d.summary.complete === false ? "users (a floor)" : "users" },
              { v: String(d.summary.countsOnly), k: "counts-only" },
            ]}
          />

          <Rows>
            {d.products.map((p, i) => {
              const problems = p.problems;
              return (
                <Row key={p.accountId} first={i === 0}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        p.reachable === true
                          ? "bg-ok"
                          : p.reachable === false
                            ? "bg-destructive"
                            : "bg-border",
                      )}
                    />
                    <span className="text-[13px] font-medium">{p.product}</span>
                    <span className="text-muted-foreground min-w-0 truncate font-mono text-[11.5px]">
                      {p.url ?? "URL not cached until the first collection"}
                    </span>
                    {p.shape && (
                      <Badge variant="secondary" className="font-normal">
                        {p.shape === "users" ? "list" : "counts only"}
                      </Badge>
                    )}
                    {p.status !== null && (
                      <Badge variant="secondary" className="font-mono font-normal">
                        {p.status}
                      </Badge>
                    )}
                    <span className="text-muted-foreground ml-auto shrink-0 text-[11.5px] tabular-nums">
                      {p.ms === null ? "—" : `${p.ms} ms`} · {ago(p.lastFetchedAt)}
                    </span>
                  </div>

                  <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 text-[12px]">
                    <span>
                      total{" "}
                      <span className="text-foreground tabular-nums">
                        {p.total === null ? "not published" : count(p.total)}
                      </span>
                    </span>
                    <span>
                      rows held <span className="text-foreground tabular-nums">{count(p.rowsHeld)}</span>
                    </span>
                    <span>
                      new 7d{" "}
                      <span className="text-foreground tabular-nums">
                        {p.new7d === null ? "—" : count(p.new7d)}
                      </span>
                    </span>
                    <span>
                      paying{" "}
                      <span className="text-foreground tabular-nums">
                        {p.paid === null ? "—" : count(p.paid)}
                      </span>
                    </span>
                    {p.generatedAt && <span>the product stamped it {ago(p.generatedAt)}</span>}
                  </div>

                  {p.error && (
                    <p className="text-destructive mt-1 text-[11.5px] leading-relaxed">{p.error}</p>
                  )}
                  {p.reachable === false && (
                    <p className="text-muted-foreground mt-1 text-[11.5px]">
                      The figures above are the last good document's, unchanged. Nothing was
                      overwritten.
                    </p>
                  )}
                  {p.reachable === null && !p.error && (
                    <p className="text-muted-foreground mt-1 text-[12px]">
                      Never collected. That is not a failure — nothing has asked yet.
                    </p>
                  )}

                  {!!problems.length && (
                    <div className="border-destructive/40 mt-1.5 rounded-[10px] border px-3 py-2">
                      <div className="text-destructive mb-1 text-[12px] font-medium">
                        {problems.length} field{problems.length === 1 ? "" : "s"} the validator
                        refused
                      </div>
                      <div className="flex flex-col gap-0.5">
                        {problems.map((why, n) => (
                          <div key={n} className="font-mono text-[11.5px]">
                            {why}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mt-1.5 flex flex-wrap items-center gap-3">
                    {p.shape === "users" && (
                      <Link
                        to={`/activity/users/${encodeURIComponent(p.product)}`}
                        className="text-[11.5px] underline underline-offset-2"
                      >
                        the list →
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => setOpenDoc(openDoc === p.accountId ? null : p.accountId)}
                      className="text-muted-foreground hover:text-foreground text-[11.5px] underline underline-offset-2"
                    >
                      {openDoc === p.accountId ? "hide the last document" : "the last document"}
                    </button>
                    {p.venture && (
                      <span className="text-muted-foreground text-[11.5px]">
                        filed under {p.venture.name}
                        {p.venture.matchedBy === "host" && " — by hostname, which is a guess"}
                      </span>
                    )}
                  </div>

                  {openDoc === p.accountId && (
                    <Doc accountId={p.accountId} />
                  )}

                  <EntityLinks
                    map={map.data}
                    plugin="users"
                    entity={String(p.accountId)}
                    label={p.product}
                    onLinked={() => map.reload()}
                  />
                </Row>
              );
            })}
          </Rows>

          <Note>{d.summary.note}</Note>
        </PanelSection>
      )}
    </>
  );
}

/**
 * The stored copy of the last document.
 *
 * It is fetched through the roll-up rather than kept in the list above because
 * it is several kilobytes per product and is opened for one at a time. Every
 * address in it was replaced with a placeholder before it was stored, and
 * arrays are cut to three items: this is the SHAPE, for checking a contract
 * error against, not the data.
 */
function Doc({ accountId }: { accountId: number }) {
  const doc = useApi(() => activityApi.userDocument(String(accountId)), [accountId]);
  return (
    <div className="mt-1.5">
      <p className="text-muted-foreground mb-1 text-[11px]">
        {doc.data?.note ??
          "The last stored document, with every address replaced and arrays cut to three items."}
      </p>
      <pre className="bg-accent/40 max-h-[280px] overflow-auto rounded-[10px] border px-3 py-2 font-mono text-[11px] leading-relaxed">
        {doc.loading
          ? "…"
          : (doc.data?.document ??
            "Nothing has been fetched from this endpoint yet, so there is no document to show.")}
      </pre>
    </div>
  );
}
