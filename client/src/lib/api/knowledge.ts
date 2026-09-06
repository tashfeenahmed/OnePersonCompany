import { call } from "@/lib/api";

/**
 * THE FACT STORE, FROM THIS SIDE.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND, on `api/runs.ts`'s
 * rule. Where the server says null this says null and the tab draws it: a
 * `commit` of null is "this reading is not pinned to a commit", a `url` of null
 * is "there is nothing to open" (a local checkout, or a repo fact read before
 * the commit was known) — never an empty string and never a fabricated link.
 *
 * THE TIER IS PART OF EVERY ROW because it is part of every claim. A component
 * that rendered a statement without it would be rendering an assertion, which
 * is the exact failure the store exists to prevent, so `tier` is not optional
 * anywhere in these types.
 */

export type FactKind =
  | "capability"
  | "pricing"
  | "audience"
  | "integration"
  | "limitation"
  | "metric"
  | "claim";

export type FactTier = "owner" | "repo" | "measured" | "proposed";
export type FactStatus = "active" | "corrected" | "retired";

export type Fact = {
  id: string;
  ventureId: string;
  ventureName: string | null;
  kind: FactKind;
  statement: string;
  tier: FactTier;
  source: {
    type: "repo" | "url" | "plugin" | "owner" | "model";
    ref: string;
    commit: string | null;
    /** A link to the exact line at the exact commit, where one can be built.
     *  Null for a local checkout and for anything that is not a repo fact. */
    url: string | null;
  };
  observedAt: string;
  ageDays: number;
  confidence: number;
  status: FactStatus;
  correctedBy: string | null;
  createdBy: "agent" | "owner";
  refreshAfter: string | null;
  stale: boolean;
};

export type RepoState = {
  repo: string | null;
  kind: "github" | "local" | null;
  /** The commit the stored facts were read at. */
  head: string | null;
  extractedAt: string | null;
  note: string | null;
  error: string | null;
  /** How the repository was chosen: the owner's setting, or a link. */
  via: string | null;
};

export type KnowledgeDoc = {
  venture: { id: string; name: string } | null;
  count: number;
  total: number;
  facts: Fact[];
  kinds: FactKind[];
  tiers: FactTier[];
  tierSays: Record<FactTier, string>;
  repo: RepoState | null;
  limits: { maxStatement: number };
  note: string;
};

export type Contradiction = {
  kind: FactKind;
  reason: string;
  resolved: boolean;
  a: Fact;
  b: Fact;
};

export type ContradictionDoc = {
  venture: { id: string; name: string };
  count: number;
  unresolved: number;
  contradictions: Contradiction[];
  note: string;
};

export type DeriveResult = {
  ventureId: string;
  added: number;
  refreshed: number;
  retired: number;
  /** Derivers that threw. Their facts are deliberately NOT retired — see
   *  `deriveVenture`: "no Stripe facts" and "the Stripe deriver failed" are
   *  different answers and only the first one may retire anything. */
  skipped: string[];
};

export type RefreshResult = {
  ok: boolean;
  derived?: DeriveResult;
  repo: string | null;
  kind: "github" | "local" | null;
  via: string | null;
  commit: string | null;
  skipped: string | null;
  filesRead: number;
  direct: number;
  proposed: number;
  added: number;
  refreshed: number;
  retired: number;
  dropped: Record<string, number>;
  modelUsed: string | null;
  notes: string[];
  error: string | null;
};

const body = (v: unknown) => ({ method: "POST", body: JSON.stringify(v) });

export const knowledgeApi = {
  facts: (venture: string, q: { kind?: string; tier?: string } = {}) => {
    const p = new URLSearchParams({ venture });
    if (q.kind) p.set("kind", q.kind);
    if (q.tier) p.set("tier", q.tier);
    return call<KnowledgeDoc>(`/knowledge?${p}`);
  },
  history: (venture: string) =>
    call<{ venture: { id: string; name: string }; facts: Fact[]; note: string }>(
      `/knowledge/history?venture=${encodeURIComponent(venture)}`,
    ),
  contradictions: (venture: string) =>
    call<ContradictionDoc>(`/knowledge/contradictions?venture=${encodeURIComponent(venture)}`),
  add: (venture: string, kind: FactKind, statement: string) =>
    call<{ ok: true; id: string }>("/knowledge/facts", body({ venture, kind, statement })),
  /* `inPlace` is true when the owner edited HIS OWN sentence into something
     that says the same thing about the same subject — a number changed, say.
     Nothing is superseded then, because a sentence cannot disagree with itself;
     the server sends the note that says so and the tab shows it. */
  correct: (id: string, statement: string) =>
    call<{ ok: true; inPlace: boolean; note: string; corrected: Fact; replacement: Fact }>(
      `/knowledge/facts/${id}/correct`,
      body({ statement }),
    ),
  retire: (id: string, why?: string) =>
    call<{ ok: true }>(`/knowledge/facts/${id}/retire`, body({ why })),
  confirm: (id: string) => call<{ ok: true }>(`/knowledge/facts/${id}/confirm`, body({})),
  setRepo: (venture: string, repo: string) =>
    call<{ ok: true }>("/knowledge/repo", { method: "PUT", body: JSON.stringify({ venture, repo }) }),
  refresh: (venture: string, force = false) =>
    call<RefreshResult>("/knowledge/refresh", body({ venture, force })),
};
