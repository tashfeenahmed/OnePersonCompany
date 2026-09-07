import { resolve, sep } from "node:path";

/**
 * THE REPORT THE AGENT SAVED INSTEAD OF SENDING.
 *
 * ---------------------------------------------------------------------------
 * A live agent has a file tool, and a model with a file tool and a brief that
 * says "write one document" will, some of the time, do exactly that:
 * write it — to disk, under its own home — and answer with a note saying where
 * it put it. The first dossier on this box came back as seven lines:
 * "Dossier for Jane Doe written to `/…/hermes/home/dossier_jane_doe.md`. The
 * document contains all required sections: …". The run was `done`, the row
 * held the note, and the dossier was in a file nothing on this app would ever
 * read.
 *
 * THE BRIEF NOW SAYS NOT TO — `systemBrief` tells an agent with tools that the
 * reply IS the document — and this is the net under that sentence, because a
 * rule a model follows most of the time is a rule that fails some of the time.
 * When an answer is short, talks about writing or saving, and names an
 * absolute `.md`, `.html` or `.htm` path that exists inside the agent's own
 * home, the file is the report and the note is not, so the file is read back
 * and takes the note's place in the row. A step records that this happened.
 *
 * THREE CONDITIONS, ALL REQUIRED, because reading a file off a path a model
 * typed is a thing to be careful about:
 *   — the answer is SHORT. A real report is thousands of characters; a note
 *     about a file is a few hundred. A long answer that happens to mention a
 *     path is a report that cites one, and is left alone.
 *   — the path is INSIDE ONE OF THE AGENT HOMES this app created. A model
 *     that names `/etc/passwd.md` or a path under the owner's own documents
 *     gets no read. The roots are resolved and compared with a separator, so
 *     `/…/home2/x.md` is not "under" `/…/home`.
 *   — the file HAS MORE IN IT than the note. A path to an empty file, or one
 *     the agent described but never wrote, is not a report either.
 *
 * NO `node:fs` IMPORT. The reader is injected, which is what lets the test run
 * this with a map of paths instead of a disk.
 */

/** Longer than this and the answer is a report that mentions a file, not a
 *  note about one. The observed note was 701 characters. */
const NOTE_MAX = 2_000;

/** The words a note about a saved file uses. Any one of them, near a path. */
const SAVED = /\b(written|wrote|saved|created|stored|exported|placed|put)\b/i;

/**
 * An absolute path ending in a report extension, as a model prints one — bare,
 * or wrapped in backticks or quotes, which are excluded from the match.
 *
 * `.html` AND `.htm` ARE HERE BECAUSE THE DOSSIER IS AN HTML DOCUMENT. The
 * note this file exists to catch is written by whatever the brief asked for:
 * an agent told to write one markdown document saves a `.md`, and an agent
 * told to write one HTML document saves a `.html` — same model, same habit,
 * same failure, and a filter that only knew about markdown would have started
 * missing it the day the dossier changed shape. Nothing else is accepted: the
 * extension is the only thing standing between this and reading back an
 * arbitrary file a model named.
 */
const REPORT_PATH = /(?:^|[\s`'"(])(\/[^\s`'"()<>]+\.(?:md|html|htm))(?=$|[\s`'"().,;:])/gim;

/** The path the note names, or null when the answer is not that kind of note. */
export function filedPath(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > NOTE_MAX) return null;
  if (!SAVED.test(t)) return null;
  const found = [...t.matchAll(REPORT_PATH)].map((m) => m[1]!);
  /* One path, or one path named more than once. Two different files is a
     note this cannot choose between, and it does not guess. */
  const distinct = [...new Set(found)];
  return distinct.length === 1 ? distinct[0]! : null;
}

/** Is `path` inside one of `roots`, after both are resolved? */
export function underRoots(path: string, roots: string[]): boolean {
  const p = resolve(path);
  return roots.some((r) => {
    const root = resolve(r);
    return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

/**
 * The report from the file the note names, when there is one to read.
 *
 * `read` returns the file's text or null for a file that is not there or
 * cannot be read — the caller wraps `readFileSync` in a try. Null from here
 * means "keep the answer as it was".
 */
export function readFiled(
  text: string,
  opts: { roots: string[]; read: (path: string) => string | null },
): { path: string; text: string } | null {
  const path = filedPath(text);
  if (!path) return null;
  if (!opts.roots.length || !underRoots(path, opts.roots)) return null;
  const body = opts.read(path);
  if (body === null) return null;
  const report = body.trim();
  if (!report || report.length <= text.trim().length) return null;
  return { path, text: report };
}
