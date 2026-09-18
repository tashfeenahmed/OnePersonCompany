import { Bot, FileText, ListChecks, MessageSquareText, SearchCheck, Smartphone, Swords, Telescope, UserRound, type LucideIcon } from "lucide-react";

/**
 * THE NINE OUTPUTS — each the work of one kind of sub-agent, each a page at
 * /outputs/<slug>. This is the registry the sidebar's accordion, the Outputs
 * page and its venture rail all read, and it deliberately imports NO PAGE:
 * the sidebar is in the main bundle, and a registry that pulled nine report
 * pages in with it would load them all before the first paint of the chat.
 * The slug → page map lives in pages/Outputs.tsx, which is lazy.
 *
 * `kind` is the server's discriminator for the runs this page reads, which
 * is the slug for all but one — the visibility app reads `geo` runs, because
 * the measurement is called GEO in the trade. See shared/runRoutes.ts.
 */
export type OutputDef = { slug: string; kind: string; name: string; icon: LucideIcon };

export const OUTPUTS: readonly OutputDef[] = [
  { slug: "research", kind: "research", name: "Research", icon: Telescope },
  { slug: "competitors", kind: "competitors", name: "Competitors", icon: Swords },
  { slug: "demand", kind: "demand", name: "Demand", icon: MessageSquareText },
  { slug: "visibility", kind: "geo", name: "AI visibility", icon: Bot },
  { slug: "seo", kind: "seo", name: "SEO", icon: SearchCheck },
  { slug: "serp", kind: "serp", name: "SERP", icon: ListChecks },
  { slug: "aso", kind: "aso", name: "ASO", icon: Smartphone },
  { slug: "papers", kind: "papers", name: "Papers", icon: FileText },
  /* The People analyst's work, and the one app here whose runs belong to no
     venture — see pages/runs/Dossiers.tsx. */
  { slug: "dossier", kind: "dossier", name: "People", icon: UserRound },
];

/**
 * THE OWNER'S ORDER OVER THE REGISTRY'S. `appOrder` is a list of slugs the
 * owner dragged into place; anything the registry has that the list does not
 * (a new app shipped since) is appended in registry order, and a slug the
 * list has that the registry does not (an app removed) is simply not drawn.
 * Neither case needs a migration, which is the point of resolving it here.
 */
export function orderedOutputs(appOrder: readonly string[] | undefined): OutputDef[] {
  const known = appOrder ?? [];
  const rank = (a: OutputDef) => {
    const i = known.indexOf(a.slug);
    return i >= 0 ? i : known.length + OUTPUTS.indexOf(a);
  };
  return [...OUTPUTS].sort((a, b) => rank(a) - rank(b));
}

export const outputBySlug = (slug: string | undefined): OutputDef | undefined =>
  OUTPUTS.find((o) => o.slug === slug);
