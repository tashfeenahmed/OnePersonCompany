import { call } from "@/lib/api";
import { qs } from "@/lib/qs";

/** One thing the server found. The shape is `FindHit` in
 *  server/src/routes/find.ts; `to` is the server's, never composed here. */
export type FindHit = {
  group: "chat" | "card" | "report" | "venture" | "person";
  id: string;
  title: string;
  snippet: string | null;
  to: string;
  ventureId: string | null;
  at: string | null;
  matches?: number;
};

/** What was said and written, as opposed to what things are called — the page
 *  matches names itself. Abortable, because every keystroke supersedes the
 *  last question. */
export const find = (q: string, signal?: AbortSignal) =>
  call<{ q: string; hits: FindHit[] }>(`/find${qs({ q })}`, { signal });
