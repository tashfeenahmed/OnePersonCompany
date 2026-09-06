/**
 * THE SKILLS CATALOGUE, AS THIS AREA SEES IT — and the snapshots taken from it.
 *
 * It is a file of its own for a boring but real reason: the engine needs the
 * catalogue to validate a rule and to take snapshots, and the narrator needs
 * to know WHICH skills were snapshotted so it can diff them. Putting both in
 * engine.ts would make the narrator import the engine and the engine import
 * the narrator, which is a cycle that works in ESM right up until somebody
 * moves a constant to the top level of a module.
 *
 * NOTHING HERE READS A TABLE THAT BELONGS TO ANOTHER AREA. The catalogue
 * arrives over loopback HTTP from `/api/skills`, exactly as it would for the
 * `opc` command or for an agent; this file's only database access is writing
 * the snapshot rows it just fetched.
 */
import { serviceHeaders } from "../../auth.ts";
import { rules, writeSnapshot } from "./store.ts";

/* One answer for "where is this box's own skills surface", shared with the
   address module the rule engine reads figures through — so a snapshot and
   the rule that watches it can never be fetched from two different ports. */
import { apiBase } from "../../shared/metrics-address.ts";
export { apiBase };

/**
 * How many skills a narration may read. Six documents is already several
 * hundred kilobytes before it is reduced to movements, and a prompt cannot
 * hold more than that without the figures that matter falling off the end.
 */
export const NARRATION_SKILLS = 6;

/**
 * TWO KINDS OF SKILL ARE NEVER SNAPSHOTTED, on purpose.
 *
 * Anything marked `openWorld` reaches off this machine — `search` is the one
 * today — and a background timer must not make a web search every half hour.
 * And `mailbox` reads live Gmail: its own skill rules promise that nothing is
 * stored and nothing is logged, and a snapshot table full of subject lines
 * would break that promise on this area's behalf.
 */
export const NEVER_SNAPSHOT = new Set(["mailbox"]);

export type CatalogueParam = {
  name: string;
  type: string;
  required: boolean;
  default: unknown;
  in: string;
  about: string;
};
export type CatalogueView = {
  key: string;
  route: string;
  about: string;
  params: CatalogueParam[];
};
export type CatalogueSkill = {
  id: string;
  title: string;
  connected: boolean;
  about: string;
  rules: string[];
  views: CatalogueView[];
  openWorld: boolean;
};

/**
 * The same catalogue the client's rule editor draws its pickers from, read by
 * the server for validation — so a rule the page could not have offered cannot
 * be stored by a POST either.
 *
 * READ FRESH ON EVERY CALL rather than cached. Connecting a plugin changes
 * which skills are live, and a validator holding a five-minute-old idea of
 * that would refuse a rule against a plugin the owner connected a minute ago.
 * It is one loopback request onto a route that opens no database.
 */
export type Catalogue = {
  /** The LIVE skills, with their views and parameters. */
  skills: CatalogueSkill[];
  /**
   * The ones that exist and are not connected — id, title and the plugins that
   * would have to be. They carry NO views, because the catalogue does not
   * publish them for a skill that cannot answer, and that is why a rule cannot
   * be written against one: this box cannot check a path against a document
   * shape it has never seen. Naming them separately is what lets the rule
   * routes say "that plugin is not connected" rather than "there is no such
   * thing", which are different problems with different fixes.
   */
  disconnected: { id: string; title: string; needs: string[] }[];
};

export async function catalogueDoc(signal?: AbortSignal): Promise<Catalogue> {
  /* The service key: a loopback read of this box's own catalogue, which
     carries no cookie and is refused once a password is set. See auth.ts. */
  const res = await fetch(`${apiBase()}/api/skills`, { headers: serviceHeaders(), signal });
  if (!res.ok) throw new Error(`the skills catalogue answered ${res.status}`);
  const doc = (await res.json()) as Partial<Catalogue>;
  return { skills: doc.skills ?? [], disconnected: doc.disconnected ?? [] };
}

export async function catalogue(signal?: AbortSignal): Promise<CatalogueSkill[]> {
  return (await catalogueDoc(signal)).skills;
}

/**
 * WHICH SKILLS GET SNAPSHOTTED, in order.
 *
 * Thirty-odd connected skills read every half hour is thirty-odd documents of
 * which most would never be looked at. So: the skills the owner's own rules
 * name first — those are the figures they said they cared about — then the
 * connected list in registry order to fill, capped at six.
 */
export function snapshotOrder(live: CatalogueSkill[], named: string[]): string[] {
  const ok = new Map(
    live.filter((s) => s.connected && !s.openWorld && !NEVER_SNAPSHOT.has(s.id)).map((s) => [s.id, s]),
  );
  const out: string[] = [];
  for (const id of named) if (ok.has(id) && !out.includes(id)) out.push(id);
  for (const id of ok.keys()) if (!out.includes(id)) out.push(id);
  return out.slice(0, NARRATION_SKILLS);
}

/** The skills that will be snapshotted on the next pass, asked live. */
export async function snapshotSkills(signal?: AbortSignal): Promise<string[]> {
  const cat = await catalogue(signal);
  return snapshotOrder(cat, rules({ enabledOnly: true }).map((r) => r.skill));
}

/**
 * Take this cycle's snapshots.
 *
 * A SKILL THAT DID NOT ANSWER WRITES NO ROW, so a gap in the table means "not
 * read" rather than "read as empty" — see 103_alert_snapshots. Nothing here
 * throws: a snapshot pass is context for a narration, and losing it must never
 * cost an alert.
 */
export async function takeSnapshots(named: string[], at: string, signal?: AbortSignal): Promise<number> {
  const cat = await catalogue(signal);
  let n = 0;
  for (const id of snapshotOrder(cat, named)) {
    try {
      const res = await fetch(`${apiBase()}/api/skills/${encodeURIComponent(id)}`, {
        headers: serviceHeaders(),
        signal,
      });
      if (!res.ok) continue;
      writeSnapshot(id, await res.json(), at);
      n += 1;
    } catch {
      /* Deliberately silent — see above. */
    }
  }
  return n;
}
