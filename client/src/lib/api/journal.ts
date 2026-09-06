import { BASE, call } from "@/lib/api";
import { qs } from "@/lib/qs";

/**
 * THE JOURNAL, FROM THIS SIDE.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND, and one field in
 * particular is the server's to decide rather than this side's: `trackable`.
 * Whether an entry can be handed to the outcomes engine is a rule about kinds
 * and links that lives in `integrations/journal/routes.ts`, and a client that
 * re-derived it would draw a button the server then refuses — or, worse, hide
 * one it would have accepted.
 *
 * `source` is likewise read and never written: each door on the server stamps
 * its own, so a page cannot file an entry as though it came from Telegram and
 * the agent cannot file one as though the owner typed it.
 */

export type JournalKind = "did" | "shipped" | "posted" | "met" | "decided" | "other";

export type JournalEntry = {
  id: string;
  kind: string;
  text: string;
  url: string | null;
  /** A LOCAL DAY, YYYY-MM-DD. Never an instant: see the route's definitions. */
  at: string;
  result: string | null;
  outcomeId: string | null;
  source: "ui" | "telegram" | "agent";
  createdAt: string;
  ventureId: string | null;
  venture: { id: string; slug: string; name: string } | null;
  trackable: boolean;
  backdated: boolean;
};

export type Streak = {
  current: number;
  longest: number;
  lastDay: string | null;
  /** False with a positive `current` means yesterday was the last day and
   *  today is still open — not that the run is broken. */
  today: boolean;
  days: number;
  /** Which sources the days were counted over — the owner's own, never the
   *  agent's. A streak is a claim about who did something. */
  sources: string[];
  /** How many rows the agent filed that the run above therefore leaves out. */
  agentFiled: number;
};

export type JournalDoc = {
  window: { days: number | null; from: string | null; to: string };
  venture: { id: string; slug: string; name: string } | null;
  kind: string | null;
  /** Over the WHOLE window, counted by the database — not the length of
   *  `entries`, which `limit` may have cut. `returned` is that. */
  count: number;
  returned: number;
  limit: number;
  counts: Record<string, number>;
  streak: Streak;
  entries: JournalEntry[];
  kinds: JournalKind[];
  windows: number[];
  definitions: Record<string, string>;
};

export const journalApi = {
  list: (params: { venture?: string; kind?: string; days?: string; limit?: number } = {}) =>
    call<JournalDoc>(`/journal${qs(params)}`),

  add: (body: {
    kind: string;
    text: string;
    venture?: string;
    url?: string;
    at?: string;
    result?: string;
  }) => call<{ entry: JournalEntry }>("/journal", { method: "POST", body: JSON.stringify(body) }),

  setResult: (id: string, result: string | null) =>
    call<{ entry: JournalEntry }>(`/journal/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ result }),
    }),

  remove: (id: string) =>
    call<{ deleted: JournalEntry; note: string | null }>(`/journal/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  track: (
    id: string,
    body: { skill: string; view?: string; params?: Record<string, string>; path: string; unit?: string },
  ) =>
    call<{ entry: JournalEntry; outcomeId: string; baseline: { value: number | null; error: string | null } }>(
      `/journal/${encodeURIComponent(id)}/outcome`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /** The export is a plain address rather than a fetch: the browser's own
   *  download is the right thing for a file, and a blob assembled here would
   *  have to re-invent the filename the route already sets. */
  exportHref: (format: "csv" | "json", venture?: string) =>
    `${BASE}/journal/export${qs({ format, venture })}`,
};
