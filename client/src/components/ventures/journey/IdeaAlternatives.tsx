import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Phone, X } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { runsApi, type CompetitorProfile } from "@/lib/api/runs";
import type { Venture } from "@/lib/api";
import { appPage } from "../../../../../shared/navigation";

/**
 * WHO IS ALREADY DOING THIS, ON THE IDEA PAGE ITSELF.
 *
 * The alternatives lived one app away, behind "Understand the alternatives" —
 * a link from the page that asks the question to a table that answers it. For
 * an idea that is the wrong way round: who else is in the room is part of the
 * idea, and the refine call files them here as it finds them (see
 * server/src/integrations/ideacall/tools.ts, `save_competitors`). Each one is a
 * door to its own website first and a row second, because the owner's next
 * move is to go and look.
 *
 * The same registry the competitor sweep writes — `competitor_profiles` — so a
 * rival met on a call and met again by a sweep is one entry, and the full table
 * (with prices over time and what changed) is still where it was.
 */
export function IdeaAlternatives({ venture, refreshKey, onCall }: { venture: Venture; refreshKey: number; onCall: () => void }) {
  const request = useApi(() => runsApi.competitors(venture.id), [venture.id, refreshKey]);
  const [removing, setRemoving] = useState<string | null>(null);
  const profiles = request.data?.profiles ?? [];

  async function remove(profile: CompetitorProfile) {
    if (removing || !confirm(`Remove ${profile.name} from the alternatives?`)) return;
    setRemoving(profile.name);
    try { await runsApi.removeCompetitor(venture.id, profile.name); request.reload(); }
    finally { setRemoving(null); }
  }

  return <section className="journey-card">
    <div className="journey-card-header">
      <div><h2>Who is already doing this.</h2><p className="journey-muted mt-1">{profiles.length ? `${profiles.length} alternative${profiles.length === 1 ? "" : "s"} your customer could choose instead` : "The products and workarounds your customer uses today"}</p></div>
      {profiles.length > 0 && <Link to={`${appPage("competitors")}?venture=${encodeURIComponent(venture.id)}`} className="text-muted-foreground flex items-center gap-1 text-xs">Full comparison<ArrowUpRight className="size-3.5" /></Link>}
    </div>
    {request.error && <p className="journey-note" role="alert">Could not read the alternatives: {request.error}</p>}
    {!profiles.length && !request.loading && !request.error && <div className="journey-note flex flex-wrap items-center justify-between gap-3">
      <span>Nothing here yet. On a refine call the assistant searches for them, reads their sites and prices, and lists them here.</span>
      <button onClick={onCall} className="flex items-center gap-1.5 font-medium"><Phone className="size-3.5" />Refine idea</button>
    </div>}
    <ul className="idea-alternatives">{profiles.map(p => <li key={p.name}>
      <div className="flex min-w-0 items-center gap-2.5">
        {/* The site's own icon, asked of the site. No third-party favicon
            service: that would tell somebody else which rivals are being read. */}
        {p.domain && <img src={`https://${p.domain}/favicon.ico`} alt="" width={18} height={18} loading="lazy" className="size-[18px] shrink-0 rounded" onError={e => { e.currentTarget.style.visibility = "hidden"; }} />}
        <strong className="truncate font-medium">{p.name}</strong>
        {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground flex min-w-0 items-center gap-1 text-xs"><span className="truncate">{p.domain ?? p.url}</span><ArrowUpRight className="size-3 shrink-0" /></a>}
        <button className="text-muted-foreground hover:text-foreground ml-auto shrink-0 p-1" aria-label={`Remove ${p.name}`} disabled={removing !== null} onClick={() => { void remove(p); }}><X className="size-3.5" /></button>
      </div>
      {p.positioning && <p className="mt-1.5 text-sm">{p.positioning}</p>}
      {(p.pricing || p.weaknesses.length > 0) && <p className="journey-muted mt-1">{[p.pricing && `Pricing: ${p.pricing}`, p.weaknesses.length > 0 && `Weak spot: ${p.weaknesses[0]}`].filter(Boolean).join(" · ")}</p>}
    </li>)}</ul>
  </section>;
}
