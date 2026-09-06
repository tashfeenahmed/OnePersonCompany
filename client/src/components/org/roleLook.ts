import { runPage } from "../../../../shared/runRoutes";
import {
  Bot,
  FileText,
  MessageSquareText,
  SearchCheck,
  Swords,
  Telescope,
  type LucideIcon,
} from "lucide-react";
import { statusTone, statusWord } from "@/components/runs/format";
import type { Subagent } from "@/lib/api/subagents";

/**
 * THE FOUR THINGS EVERY SCREEN THAT DRAWS A WORKER NEEDS: its icon, the app
 * its work is read in, the word for what it is doing, and the colour of the
 * dot beside that word.
 *
 * A .ts beside the components rather than inside one of them, the same shape
 * `runs/format.ts` has and for the same reason: the org chart, the roster, the
 * venture overview and the worker's own page all draw a status, and the fourth
 * copy is the one that starts saying "idle" where the others say "never run".
 *
 * THE ICONS ARE THE APPS' ICONS, deliberately. A sub-agent is the app with a
 * name on it — the SEO analyst runs exactly what the SEO app runs — so a
 * second visual language for the same six things would be six more symbols to
 * learn for no new fact. Where the roster and the tab strip disagree about
 * what a magnifying glass means, the roster is wrong.
 */

/**
 * By role, because a role is what a page has in its URL.
 *
 * A MAP RATHER THAN A FUNCTION, and that is not a style choice: a component
 * that comes out of a CALL during render reads to the linter — correctly —
 * as a component being CREATED during render, which resets its state on every
 * pass. An indexed lookup with a fallback is the same fact expressed as data.
 * See `RoleIcon` for the one place this is drawn.
 */
export const ROLE_ICONS: Record<string, LucideIcon> = {
  researcher: Telescope,
  competitors: Swords,
  seo: SearchCheck,
  demand: MessageSquareText,
  visibility: Bot,
  writer: FileText,
};

/** What a role this build has never heard of is drawn as. Not nothing: a row
 *  with a hole where its mark should be looks like a bug rather than like a
 *  role added since this client was built. */
export const FALLBACK_ROLE_ICON = Bot;

/**
 * Where a run of this kind is readable, when the server has not said.
 *
 * THE SERVER SAYS, NORMALLY: `RoleInfo.app` is on the org document precisely
 * so this client is not the thing that decides a `geo` run belongs to the AI
 * visibility tab. This map is the fallback for the two places that have a
 * worker without the roles beside it — the detail response and the venture
 * overview — and it is the same map `pages/Subagents.tsx` has always carried,
 * kept in one file now that three pages want it.
 *
 * A kind with no app here is NOT linked, which is the correct offer for a run
 * this client cannot open.
 */
const KIND_APPS: Record<string, string> = {
  research: "research",
  competitors: "competitors",
  seo: "seo",
  demand: "demand",
  geo: "visibility",
  papers: "papers",
  video: "video",
  shotsqa: "ops",
  serp: "serp",
  aso: "aso",
};

export const appForKind = (kind: string): string | null =>
  KIND_APPS[kind] ?? null;

/** A run's address, or null for a kind this client has no app for. */
export function runAddress(run: { kind: string; id: string }): string | null {
  const app = appForKind(run.kind);
  return app ? runPage(run.kind, run.id) : null;
}

/**
 * A worker's name with the venture's own name taken off the front.
 *
 * THE DEFAULT NAME IS "<Venture> SEO Analyst", and on a card whose header
 * already says Example App 1, drawing it in full puts the word Example App 1 on the
 * screen seven times and truncates the half that differs. So the prefix is
 * stripped WHEN IT IS THERE — a name the owner has changed to something else
 * is drawn exactly as they typed it, which is the whole reason this trims a
 * prefix rather than falling back to the role's title.
 */
export function shortName(name: string, venture: string): string {
  return name.startsWith(`${venture} `) ? name.slice(venture.length + 1) : name;
}

/** A worker's page. Built from the venture's slug rather than the worker's id,
 *  because /ventures/example-app-1/team/seo is an address somebody can read. */
export const teamAddress = (ventureSlug: string, role: string) =>
  `/ventures/${encodeURIComponent(ventureSlug)}/team/${encodeURIComponent(role)}`;

/**
 * WHAT THIS WORKER IS DOING, IN ONE WORD AND ONE COLOUR.
 *
 * The order is the order of urgency and it is not the order of the fields:
 * work in flight beats the switch, because a disabled worker with a run
 * executing is a real state (the switch went off mid-run) and "off" beside a
 * spinning report would be the interface contradicting the queue.
 *
 * "never run" is a fourth state and not a zero. A worker nobody has addressed
 * and a worker whose last three reports failed are different situations, and
 * both of them have no green dot.
 */
export function standing(sa: Subagent): { word: string; tone: string } {
  if (sa.running) return { word: "working", tone: "bg-ok animate-pulse" };
  if (sa.queued > 0)
    return {
      word: sa.queued === 1 ? "1 waiting" : `${sa.queued} waiting`,
      tone: "bg-warn",
    };
  if (!sa.enabled) return { word: "off", tone: "bg-border" };
  if (sa.lastRun)
    return {
      word: statusWord(sa.lastRun.status),
      tone: statusTone(sa.lastRun.status),
    };
  return { word: "never run", tone: "bg-border" };
}
