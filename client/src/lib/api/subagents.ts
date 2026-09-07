import { call, type VentureStage } from "@/lib/api";
import type { RunSummary } from "@/lib/api/runs";

/**
 * THE ORG: who works here, for which venture, and what they run.
 *
 * A SUB-AGENT IS NOT A NEW KIND OF WORK. It is a NAME on work this box has
 * been doing for weeks: a run of kind `seo` filed under a venture was always
 * "that venture's SEO analyst doing its job", and the only thing that was missing
 * was somebody to address. So nothing here starts a seventh sort of run —
 * `dispatch` posts the same run the SEO app posts, with a brief typed at a
 * worker rather than into a form, and the report lands in the same place with
 * the same address.
 *
 * WHICH MEANS THE ROSTER COUNTS RUNS NOBODY DISPATCHED. A run started from the
 * app with a venture chosen is that venture's sub-agent's work by definition —
 * kind plus venture IS the role — and the server derives it at read time
 * rather than back-filling a column. `lastRun` on a worker nobody has ever
 * addressed by name is therefore usually not null, and that is correct rather
 * than surprising.
 *
 * THE TYPES ARE TRANSCRIBED FROM THE SERVER'S, and `RunSummary` is imported
 * from the runs area rather than restated: a sub-agent's last run is a run,
 * and a second copy of that type is the one that would drift the day a field
 * is added to it.
 */

/*
 * THERE IS NO UNION OF ROLES HERE ANY MORE, and its deletion is the point.
 * It listed six — researcher, competitors, seo, demand, visibility, writer —
 * on an org that had grown to ten and then eleven, nothing imported it, and a
 * type nobody reads is a type that is wrong in silence. A role is a STRING on
 * the wire; a role this build has never heard of draws with the fallback icon
 * rather than failing to compile, which is the behaviour every page here
 * already has (see `ROLE_ICONS`).
 */

/**
 * What a role IS, as the server describes it: the kind of run it starts, the
 * app that run is readable in, and the sentence that says what it is for.
 *
 * Shipped once at the top of the org document rather than repeated on all one
 * hundred and fourteen workers, because it is a fact about the ROLE and not
 * about the person holding it.
 */
export type RoleInfo = {
  role: string;
  /** The runs area's kind: research, competitors, seo, demand, geo, papers. */
  kind: string;
  title: string;
  what: string;
  /** The app slug a run of this kind is read at — `/apps/<app>/<runId>`. */
  app: string;
  /** True for a role provisioned once for the whole box rather than once per
   *  venture — the People analyst. */
  portfolio?: boolean;
};

/**
 * One worker.
 *
 * `enabled` IS THE OWNER'S SWITCH and `running` is a fact about the queue; a
 * disabled worker with a run in flight is an ordinary state (the switch went
 * off while it was working) and the page has to be able to draw both at once.
 *
 * `instructions` is standing text the owner typed, prepended to every brief
 * this worker is given. "" is the common case and means nothing has been said,
 * which is not the same as a worker told to do nothing.
 */
export type Subagent = {
  id: string;
  /** Null for a worker that belongs to no venture — see `portfolio`. */
  ventureId: string | null;
  role: string;
  kind: string;
  name: string;
  title: string;
  instructions: string;
  enabled: boolean;
  running: boolean;
  queued: number;
  /**
   * THIS WORKER BELONGS TO NO VENTURE.
   *
   * A flag rather than `ventureId === null` read at each call site, because
   * the two facts are not the same one: a venture worker whose venture has
   * just been deleted would also have no id, and drawing it in the "across
   * every venture" card would be the org chart inventing a portfolio. The
   * server says which this is; nothing here infers it.
   */
  portfolio: boolean;
  /** The newest run of this kind for this venture, dispatched or not. Null
   *  means this worker has never done anything — not that it failed. */
  lastRun: RunSummary | null;
  counts: { done: number; failed: number };
};

/** A venture, as the org document names one. The favicon is the venture's own
 *  stored data: URL, so the chart draws with no second request and no store
 *  lookup — the org is readable on a browser that has never loaded /ventures. */
export type OrgVenture = {
  id: string;
  slug: string;
  name: string;
  color: string;
  stage: VentureStage;
  favicon: string | null;
};

export type OrgVentureTeam = OrgVenture & { subagents: Subagent[] };

/**
 * WHO THE CHIEF OF STAFF IS, WHICH IS THE ONE HONEST THING ON THIS PAGE.
 *
 * The chat agent is the top of the org below the owner, and it is not always
 * the same thing: a live backend (hermes, openclaw) investigates with tools,
 * and when none is connected the same chat falls back to one completion from
 * the raw provider. `connected: false` with a label is "this is what would
 * answer"; `backend: null` is nothing configured at all. The card says which,
 * because an org chart with a confident box at the top of a machine with no
 * agent on it is the exact lie this app does not tell.
 */
export type ChiefOfStaff = {
  backend: string | null;
  label: string | null;
  connected: boolean;
  skills: number;
};

export type Org = {
  owner: { name: string };
  chiefOfStaff: ChiefOfStaff;
  roles: RoleInfo[];
  ventures: OrgVentureTeam[];
  /**
   * THE WORKERS WITH NO VENTURE ABOVE THEM, in the order the chart draws
   * them. Empty on a server that has none — which is not the same as absent,
   * and is why the chart's card is drawn only when there is something in it
   * rather than as a permanently empty box.
   */
  portfolio: Subagent[];
  summary: { subagents: number; enabled: number; running: number; queued: number };
};

/**
 * ONE EXCHANGE ON THE WORKER'S PAGE: what was asked, and what came back.
 *
 * A run, drawn as a conversation. `brief` is the owner's words on the right —
 * the stored brief for a dispatched run, or the kind's own free-text field for
 * one started from an app page, and `asked` says which so the page can label
 * the second. `output` is the report on the left, whole or `partial` while it
 * is still being written, and `queuePosition` is where it waits when it has
 * not started. `cards` is how many board suggestions the report ends with;
 * they are filed from the run's own page, not from here.
 */
export type Exchange = {
  run: RunSummary;
  brief: string;
  asked: "brief" | "form";
  /** A named worker was addressed, rather than the owner starting this kind
   *  of run by hand. Narrower than "whose work it is" — see the org types. */
  dispatched: boolean;
  /** The chat the brief was typed in, or null for one typed on the worker's
   *  page or started from an app. */
  parentSessionId: string | null;
  output: string;
  partial: boolean;
  queuePosition: number | null;
  cards: number;
};

/** One worker with its venture and everything it has ever run, newest first —
 *  and the newest twenty of those as a transcript, oldest first, with their
 *  reports in full. */
export type SubagentDetail = Subagent & {
  /** Null for a portfolio worker. The pages that draw a venture name have to
   *  cope with that rather than with a placeholder venture, because there is
   *  no venture — see `pages/Subagent.tsx`. */
  venture: OrgVenture | null;
  runs: RunSummary[];
  transcript: Exchange[];
};

/** What a dispatch answers with: the run as it now is — queued, or running
 *  when nothing else was — and the worker as it now is. */
export type Dispatched = { run: RunSummary; subagent: Subagent };

const seg = (s: string) => encodeURIComponent(s);

/**
 * A WORKER'S ID IS DERIVABLE, and this is the only place that says so.
 *
 * The server's primary key is `sa-<ventureId>-<role>`, which means a page that
 * knows a venture and a role can address a worker without reading the whole
 * org document first — 114 workers to draw one. It is a coupling and it is
 * declared here rather than spelled out inside a page, so the day the server
 * changes its key there is one line to change and one page to re-check.
 *
 * Every caller has a fallback for the id being wrong: see `findSubagent`.
 */
export const subagentId = (ventureId: string, role: string) =>
  `sa-${ventureId}-${role}`;

/**
 * The same derivation for a worker with no venture: `sa-portfolio-<role>`.
 *
 * "portfolio" IS THE VENTURE ID'S PLACE, which is what keeps one key shape on
 * the server rather than two. It is written here beside the other one so the
 * day the key changes there is still exactly one file to edit, and the
 * fallback below still answers if it changes without this being edited.
 */
export const portfolioSubagentId = (role: string) => `sa-portfolio-${role}`;

export const subagentApi = {
  /** The whole org: the owner, the chief of staff, the roles and every
   *  venture's six. One document, because the chart is one picture. */
  org: () => call<Org>("/subagents"),

  one: (id: string) => call<SubagentDetail>(`/subagents/${seg(id)}`),

  save: (
    id: string,
    patch: {
      name?: string;
      title?: string;
      instructions?: string;
      enabled?: boolean;
    },
  ) =>
    call<Subagent>(`/subagents/${seg(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  /**
   * Queue this worker's kind of run against its venture.
   *
   * `parentSessionId` is what files the run UNDER a chat in the rail. It is
   * optional here and always absent from the sub-agent page — a brief typed
   * on a worker's own page belongs to nobody's conversation; it belongs to the
   * worker's own transcript, which is where that page draws it.
   */
  dispatch: (
    id: string,
    body: {
      brief: string;
      parentSessionId?: string;
      input?: Record<string, string>;
    },
  ) =>
    call<Dispatched>(`/subagents/${seg(id)}/dispatch`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/**
 * The worker for this venture and role, whichever of the two the page happens
 * to know.
 *
 * THE FAST PATH IS THE DERIVED ID, and the fallback is not belt and braces.
 * The id format is the server's to change; the pairing of a venture and a role
 * is the thing that actually exists and is guaranteed — every venture is
 * provisioned with all six on every read. So a miss on the derived id is
 * treated as "the key is not what this build thinks it is" and answered by
 * looking the worker up the slow way, once, rather than by telling the owner
 * their SEO analyst does not exist.
 *
 * A SLUG IS ENOUGH ON ITS OWN, which is what makes the worker's page
 * independent of the store. The address carries a slug; the store's venture
 * list is a cache that may not have arrived yet, or at all; and a page that
 * said "no venture at this address" because a *different* fetch was slow would
 * be reporting the wrong failure. The org document knows both.
 *
 * AND NO VENTURE AT ALL IS A THIRD CASE, not a missing argument. The People
 * analyst belongs to nobody's business: its address is /team/people, it has
 * neither a slug nor an id to hand, and it is looked up in the org's
 * `portfolio` list. The fast path is the same trick — `sa-portfolio-people` —
 * with the same fallback behind it.
 *
 * Null means there is no such worker — a role nobody has heard of, a venture
 * that has been deleted. A server that cannot be reached throws instead, so
 * the two are never confused.
 */
export async function findSubagent(opts: {
  role: string;
  ventureId?: string | null;
  slug?: string | null;
}): Promise<SubagentDetail | null> {
  /* NEITHER A SLUG NOR AN ID MEANS THE PORTFOLIO, and it means it positively
     rather than by accident. /team/people carries no venture because the
     worker at it HAS none; the venture pages always carry one of the two. So
     the absence is the question being asked, not a caller that forgot. */
  const noVenture = !opts.ventureId && !opts.slug;
  const guessId = noVenture
    ? portfolioSubagentId(opts.role)
    : opts.ventureId
      ? subagentId(opts.ventureId, opts.role)
      : null;
  if (guessId) {
    const guess = await subagentApi.one(guessId).catch(() => null);
    if (guess) return guess;
  }
  const org = await subagentApi.org();
  if (noVenture) {
    /* `?? []` because a server built before the portfolio existed sends no
       such field, and "this build asked an older server" must read as "no
       such worker" rather than as a crash on the page. */
    const found = (org.portfolio ?? []).find((s) => s.role === opts.role);
    return found ? await subagentApi.one(found.id) : null;
  }
  const venture = org.ventures.find((v) =>
    opts.ventureId ? v.id === opts.ventureId : v.slug === opts.slug,
  );
  const found = venture?.subagents.find((s) => s.role === opts.role);
  return found ? await subagentApi.one(found.id) : null;
}
