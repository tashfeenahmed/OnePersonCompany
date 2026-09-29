import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Check, Loader2, Search, Settings2, Users } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PluginSettingsForm } from "@/components/settings/PluginSettingsForm";
import { useApi } from "@/hooks/useApi";
import { ago, day } from "@/lib/format";
import { EmptyState, FilterChips, Problem, SmallPrint } from "@/areas/mailflow/parts";
import { humanizeStamps } from "@/lib/mailText";
import { peopleApi } from "@/lib/api/people";
import { ContactPanel, ContactRow } from "./parts";

/**
 * WHO THE OWNER ACTUALLY WRITES WITH — and, with `stale`, who has gone quiet.
 *
 * ITS OWN FILE BECAUSE THE PAGE IT SAT ON IS GONE. This and Brief were
 * components inside People.tsx, drawn under People's own header; both are tabs
 * of the Email page now — see pages/Email.tsx — because a correspondence is
 * mail, and a second page for the mailbox's people was a second door onto the
 * same subject.
 *
 * ONE COMPONENT FOR TWO TABS. `stale` is the whole difference between
 * /mail/contacts and /mail/stale: the same list, asked of the server with the
 * stale filter on. Two files would be two search boxes that drifted apart.
 *
 * WHAT THIS MAY NOT SAY, drawn in the page rather than buried in a tooltip:
 * this is mail METADATA. No subject line, snippet or body is in any of the
 * tables behind it, so it cannot say what anybody talked about, and a cooling
 * correspondence here is an arithmetic fact about dates and not a story about
 * a relationship.
 *
 * THE PEOPLE SETTINGS OPEN FROM HERE, behind the Settings button in the
 * action slot — which PageShell keeps when a page is embedded (see
 * components/PageShell.tsx), so the control survived the move onto the Email
 * shell. They live on a page rather than on an Integrations card because
 * `people` has no credential and therefore no card in the catalog — the same
 * position `backups` is in. The form is the shared one, driven entirely by
 * what `GET /api/plugins/people/config` says the server accepts, so a setting
 * this page offered that the route would refuse is not expressible.
 */
export function Contacts({ stale }: { stale: boolean }) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const navigate = useNavigate();
  /* WHICH ROW IS OPEN IS IN THE ADDRESS, so a person opened out of a search
     is reachable with the back button and can be linked to. */
  const [params, setParams] = useSearchParams();
  const open = params.get("open");
  const toggle = (address: string) => {
    const next = new URLSearchParams(params);
    if (open === address) next.delete("open");
    else next.set("open", address);
    setParams(next, { replace: true });
  };

  const doc = useApi(
    () => peopleApi.list({ stale: stale ? "1" : undefined, all: all ? "1" : undefined, limit: 400 }),
    [stale, all],
  );
  /* The day series is asked for one contact at a time, when a row is opened. */
  const person = useApi(
    () => (open ? peopleApi.person(open) : Promise.resolve(null)),
    [open],
  );

  const d = doc.data;
  const rows = (d?.contacts ?? []).filter((p) => {
    if (!q.trim()) return true;
    const needle = q.trim().toLowerCase();
    return (
      p.address.includes(needle) ||
      (p.name ?? "").toLowerCase().includes(needle) ||
      p.domain.includes(needle)
    );
  });

  return (
    <PageShell
      title={stale ? "Gone quiet" : "People"}
      wide
      action={
        <Button variant="ghost" size="sm" onClick={() => setShowSettings((s) => !s)}>
          <Settings2 className="size-3.5" strokeWidth={1.6} />
          Settings
        </Button>
      }
    >
      {showSettings && (
        <div className="border-line-soft mb-5 rounded-xl border p-4">
          <p className="text-muted-foreground mb-3 text-[13px]">
            How far back to look, how many emails each way make someone a regular contact, and how
            many silent days count as “gone quiet”.
          </p>
          <PluginSettingsForm plugin="people" onSaved={() => doc.reload()} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterChips
          label="Show"
          value={stale ? "stale" : "everyone"}
          onChange={(k) => navigate(k === "stale" ? "/mail/stale" : "/mail/contacts")}
          chips={[
            { key: "everyone", label: "Everyone", count: stale ? undefined : d?.contacts.length },
            {
              key: "stale",
              label: "Gone quiet",
              count: stale ? d?.contacts.length : undefined,
              title: d ? `No email either way for ${d.staleDays} days` : undefined,
            },
          ]}
        />
        {d && d.counts.scanned > 0 && (
          <div className="relative ml-auto w-full sm:w-[260px]">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search people"
              aria-label="Search people"
              className="h-8 pl-8 text-[13.5px]"
            />
          </div>
        )}
      </div>

      {doc.error && <Problem>{doc.error}</Problem>}
      {doc.loading && !d && (
        <p className="text-muted-foreground text-[14px]">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" /> Loading…
        </p>
      )}

      {rows.length > 0 && (
        <div className="border-line-soft divide-line-soft bg-card divide-y overflow-hidden rounded-xl border">
          {rows.map((p) => (
            <div key={`${p.mailbox} ${p.address}`}>
              <ContactRow
                p={p}
                open={open === p.address}
                onToggle={() => toggle(p.address)}
              />
              {open === p.address && (
                <ContactPanel
                  p={p}
                  days={
                    person.data?.seenIn.find((s) => s.mailbox === p.mailbox)?.days ?? []
                  }
                  loading={person.loading}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {!doc.loading && !doc.error && !rows.length && d && (
        <EmptyState
          icon={stale ? Check : Users}
          title={
            q.trim()
              ? "Nobody matches that search"
              : stale
                ? "Nobody has gone quiet"
                : "No regular contacts yet"
          }
          body={
            q.trim()
              ? "Try a name, an email address or a company domain."
              : stale
                ? `Everyone you email regularly has been in touch in the last ${d.staleDays} days.`
                : "People show up here once you've emailed back and forth a few times."
          }
        />
      )}

      {d && d.counts.scanned > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground underline"
            onClick={() => setAll((a) => !a)}
          >
            {all ? "Only show regular contacts" : `Show everyone you've emailed (${d.counts.scanned})`}
          </button>
        </div>
      )}

      {d && (
        <SmallPrint summary="How this works" className="mt-6">
          <p>
            Built from email headers only — names, addresses, counts and dates over the last {d.windowDays} days
            {d.mailboxes.length ? ` of ${d.mailboxes.join(", ")}` : ""}. Nothing here knows what anybody said.
          </p>
          <p>
            A regular contact is someone with at least {d.minEachWay} emails each way. {d.counts.warm} in touch ·{" "}
            {d.counts.cooling} cooling off · {d.counts.cold} gone cold · {d.counts.noRhythm} too new to tell.
          </p>
          <p>
            “Cooling off” and “gone cold” compare the silence with how often you usually write to that person. “Gone
            quiet” is simpler: no email either way for {d.staleDays} days.
          </p>
          {d.floors && (
            <p className="text-warn">
              Only emails back to {d.scanFrom ? day(d.scanFrom, { year: true }) : "the scan limit"} were read, so every
              count is a minimum.
            </p>
          )}
          {d.scannedAt && <p>Last updated {ago(d.scannedAt)}.</p>}
          {d.note && <p>{humanizeStamps(d.note)}</p>}
        </SmallPrint>
      )}
    </PageShell>
  );
}
