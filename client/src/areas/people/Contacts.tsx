import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Settings2 } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PluginSettingsForm } from "@/components/settings/PluginSettingsForm";
import { useApi } from "@/hooks/useApi";
import { ago } from "@/lib/format";
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
  /* WHICH ROW IS OPEN IS IN THE ADDRESS, not in a useState — the rule the
     boards and the venture tabs follow. "Look at this correspondence" is a
     thing somebody sends a link to, and a person opened out of a search is
     reachable with the back button because of it. */
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
  /* The day series is asked for one contact at a time, when a row is opened.
     Every contact's days in the list document would be tens of thousands of
     rows to draw one chart nobody has clicked. */
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

  const sub = doc.error
    ? "The API is not running, so nothing here can be read."
    : doc.loading
      ? "Reading the contacts…"
      : d
        ? [
            `${d.counts.mutual} correspondences of ${d.counts.scanned} addresses`,
            `${d.windowDays}-day window`,
            d.mailboxes.length ? d.mailboxes.join(", ") : null,
            d.scannedAt ? `read ${ago(d.scannedAt)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "";

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
          <p className="text-muted-foreground mb-3 text-[13.5px]">
            Five decisions, saved on the server and checked before they are stored. The window
            is what every count on this page is over; “minimum each way” is what separates a
            correspondence from a transaction; “stale after” is the calendar question the
            Stale tab asks.
          </p>
          <PluginSettingsForm plugin="people" onSaved={() => doc.reload()} />
        </div>
      )}

      {/* WHAT THE SCAN REACHED, IN THE PAGE AND NOT IN THE HEADER. This was
          PageShell's `sub` line, and PageShell drops its words when a page is
          embedded — which this one always is now. The Email shell's header
          says which tab you are reading; it cannot say how much of which
          mailbox was read, or when, so that sentence moved down here. */}
      {sub && <p className="text-muted-foreground mb-2 text-[12.5px]">{sub}</p>}

      {/* The promise the page is under, in the page rather than in a tooltip. */}
      <p className="text-muted-foreground mb-4 text-[12.5px]">
        Mail headers only — addresses, counts and dates. Nothing here knows what anybody said,
        so a cooling correspondence is arithmetic about dates and not a story.
        {d?.floors && (
          <span className="text-warn">
            {" "}
            The message cap bit: this scan reached back only to {d.scanFrom?.slice(0, 10)}, so
            every count is a floor.
          </span>
        )}
      </p>

      {d && d.counts.scanned > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, address or domain"
            className="max-w-[320px]"
          />
          <Button
            variant={all ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setAll((a) => !a)}
            title={`Show every address scanned, including those under the minimum of ${d.minEachWay} messages each way.`}
          >
            {all ? "Every address" : `Correspondences only (≥${d.minEachWay} each way)`}
          </Button>
          <span className="text-muted-foreground ml-auto text-[12.5px]">
            {d.counts.warm} warm · {d.counts.cooling} cooling · {d.counts.cold} cold ·{" "}
            {d.counts.noRhythm} no rhythm yet
          </span>
        </div>
      )}

      {doc.error && <p className="text-destructive text-[14.5px]">{doc.error}</p>}
      {d?.note && <p className="text-muted-foreground text-[14.5px]">{d.note}</p>}

      {rows.length > 0 && (
        <div className="border-line-soft divide-line-soft divide-y overflow-hidden rounded-xl border">
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

      {!doc.loading && !doc.error && !rows.length && d && d.counts.scanned > 0 && (
        <p className="text-muted-foreground text-[14.5px]">
          {stale
            ? `Nobody has been silent for ${d.staleDays} days. That is a statement about this ${d.windowDays}-day window, not about your whole mailbox.`
            : "Nothing matches that search."}
        </p>
      )}
    </PageShell>
  );
}
