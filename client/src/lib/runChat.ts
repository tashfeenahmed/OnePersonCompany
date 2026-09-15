import { count } from "./format.ts";

/**
 * WHICH RUN THE WORKER'S PAGE IS SHOWING, AND WHAT THE REPLY IS SIGNED WITH.
 *
 * ---------------------------------------------------------------------------
 * A WORKER'S PAGE IS A CHAT AND A RUN IS ONE EXCHANGE IN IT: the brief on the
 * right, the tool calls and the report on the left. So the page always has
 * exactly one run open — the way a chat always has one session open — and the
 * two decisions that follow from that are here rather than inside the
 * component, because they are arithmetic over data and the component is 300
 * lines of markup.
 *
 * THE ADDRESS DECIDES, AND WHEN IT SAYS NOTHING THE NEWEST RUN DOES. Landing
 * on /ventures/example-video/team/competitors with no `?run` used to draw a
 * transcript of the last twenty replies; it now opens the last conversation,
 * which is what the main chat does when you open it and the only reading of
 * "take me back to the conversation" that does not need a second click.
 *
 * "NEW" IS AN ADDRESS TOO. Pressing New brief has to be somewhere the back
 * button can return to, so the blank page is `/runs/new` rather than a flag in
 * a ref — and `new` can never collide with a run, whose ids are `r-` and six
 * characters (see the server's `store.ts`).
 *
 * A LIST FIRST IS THE PEOPLE ANALYST AND ONLY IT. That worker is addressed by
 * PERSON: its landing page is the grid of who is being watched, which is its
 * own "new chat" state — pick somebody, brief them. Opening its newest dossier
 * instead would answer a question nobody asked. The flag is passed in rather
 * than worked out here, because "which worker draws a grid" is a fact about
 * roles and this file knows nothing about roles.
 *
 * A LEAF: one relative import of the formatter, so `runChat.test.ts` can strip
 * the types and run it under node.
 */

/** The address of the blank page — a new brief, nothing open. Not a run id. */
export const NEW_BRIEF = "new";

/** What the middle of the page draws. `run` and `blank` are never both set;
 *  neither set means the page's own list state (the analyst's grid). */
export type ChatView = { run: string | null; blank: boolean };

/** A copied or edited URL must never attribute another worker's report here. */
export function runBelongsToWorker(
  run: { kind: string; ventureId: string | null },
  worker: { kind: string; ventureId: string | null },
): boolean {
  return run.kind === worker.kind && run.ventureId === worker.ventureId;
}

/**
 * The open run, from the address and the ledger.
 *
 * `runs` is the worker's whole history NEWEST FIRST — the server's order,
 * which is the claim that the first row is the latest; re-sorting here would
 * be this file quietly disagreeing with the rail beside it.
 */
export function chatView(
  param: string | null,
  runs: readonly { id: string }[],
  listFirst: boolean,
): ChatView {
  if (param === NEW_BRIEF) return { run: null, blank: true };
  if (param) return { run: param, blank: false };
  if (listFirst) return { run: null, blank: false };
  const newest = runs[0]?.id ?? null;
  /* No runs and no list to fall back on is the empty state: the introduction
     and the composer. Same page as New brief, arrived at by having nothing. */
  return { run: newest, blank: !newest };
}

/** The facts under a reply, before they are joined with " · ". */
export type Signature = {
  /** The worker's short name — who is signing it. */
  worker: string;
  /** Which agent and model wrote it, already phrased. */
  backend: string;
  /** How long it took, already formatted. "" or null while it is unknown. */
  took: string | null;
  steps: number;
  words: number;
  cards: number;
};

/**
 * THE SIGNATURE UNDER A REPLY: who wrote it, with what, how long it took, and
 * what it cost in tool calls and words.
 *
 * A FACT WITH NOTHING IN IT IS LEFT OUT rather than drawn as a zero. "0 tool
 * calls" is a claim that the agent had no tools; a run with none recorded is
 * one this box did not watch closely, and the two are not the same thing. The
 * same goes for the words of a report that has not been written yet.
 *
 * This is the strip Workdash drew above a report, said as one line under a
 * reply — the page has one layout now, and it is the conversation's.
 */
export function signature(f: Signature): string[] {
  const parts: string[] = [];
  const worker = f.worker.trim();
  if (worker) parts.push(worker);
  const backend = f.backend.trim();
  if (backend) parts.push(backend);
  const took = f.took?.trim();
  if (took) parts.push(took);
  if (f.steps > 0)
    parts.push(`${count(f.steps)} tool call${f.steps === 1 ? "" : "s"}`);
  if (f.words > 0) parts.push(`${count(f.words)} word${f.words === 1 ? "" : "s"}`);
  if (f.cards > 0)
    parts.push(`${count(f.cards)} board suggestion${f.cards === 1 ? "" : "s"}`);
  return parts;
}
