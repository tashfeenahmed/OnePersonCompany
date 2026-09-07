import { runPage } from "../../../../shared/runRoutes";
import {
  Bot,
  FileText,
  MessageSquareText,
  SearchCheck,
  Swords,
  Telescope,
  UserRound,
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
  /* The People analyst, whose app is Dossiers. A person, because that is what
     it reports on — and the only mark here that is a subject rather than an
     activity, which is right: it is the only worker that is not attached to a
     business. */
  people: UserRound,
};

/** What a role this build has never heard of is drawn as. Not nothing: a row
 *  with a hole where its mark should be looks like a bug rather than like a
 *  role added since this client was built. */
export const FALLBACK_ROLE_ICON = Bot;

/**
 * A RUN'S ADDRESS.
 *
 * THIS FILE NO LONGER CARRIES A TABLE OF KINDS. It had one — ten entries, a
 * fourth copy of a list the server and `shared/runRoutes.ts` also held — and
 * it disagreed with both: `campaign` and `mobilehealth` were absent, so a run
 * of either was drawn as plain text while the server happily linked it.
 *
 * IT ALSO NO LONGER ANSWERS NULL. The old map returned null for a kind it had
 * never heard of, which meant a kind added by the runs area silently stopped
 * being clickable in this client until somebody edited this file. `runPage`
 * falls back to the kind's own slug, and `/outputs/:output/:runId` is a real
 * route, so a new kind opens at its own page instead of at nothing.
 */
export const runAddress = (run: { kind: string; id: string }): string =>
  runPage(run.kind, run.id);

/**
 * A worker's name with the venture's own name taken off the front.
 *
 * THE DEFAULT NAME IS "<Venture> SEO Analyst", and on a card whose header
 * already carries the venture's name, drawing it in full puts that name on
 * the screen seven times and truncates the half that differs. So the prefix is
 * stripped WHEN IT IS THERE — a name the owner has changed to something else
 * is drawn exactly as they typed it, which is the whole reason this trims a
 * prefix rather than falling back to the role's title.
 */
export function shortName(name: string, venture: string): string {
  return name.startsWith(`${venture} `) ? name.slice(venture.length + 1) : name;
}

/** A worker's page. Built from the venture's slug rather than the worker's id,
 *  because /ventures/<slug>/team/seo is an address somebody can read. */
export const teamAddress = (ventureSlug: string, role: string) =>
  `/ventures/${encodeURIComponent(ventureSlug)}/team/${encodeURIComponent(role)}`;

/**
 * A worker with no venture above it: /team/people.
 *
 * THE MISSING SEGMENT IS THE FACT. The venture's workers live under the
 * venture because that is who they answer to; this one lives at the root
 * because it answers to nobody's business, and an address that invented a
 * venture to hang it off — /ventures/all/team/people — would be a place that
 * does not exist. Same page, one segment shorter.
 */
export const portfolioAddress = (role: string) =>
  `/team/${encodeURIComponent(role)}`;

/**
 * ONE WATCHED PERSON'S FILE: /team/people/<id>.
 *
 * A PERSON IS A PLACE, which is the change this address makes. Who was open
 * used to be `?person=<id>` on the analyst's own page — a filter over a
 * transcript — and a file with metrics, a timeline and a shelf of dossiers on
 * it is not a filtered view of a conversation. It is a page, so it has a path,
 * and the back button, a middle click and a pasted link all mean what they
 * look like they mean.
 *
 * THE ID AND NOT THE NAME, unlike every other address on this app. A name is
 * the one field the owner edits, and an address that changed when somebody
 * fixed a spelling would break every link already sent.
 */
export const personAddress = (id: string) =>
  `/team/people/${encodeURIComponent(id)}`;

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
