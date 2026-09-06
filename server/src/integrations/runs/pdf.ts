/**
 * MARKDOWN TO A PDF, WITH THE BROWSER THAT IS ALREADY ON THE BOX.
 *
 * THIS IS NOW THE FALLBACK, AND IT IS KEPT RATHER THAN DELETED. typst.ts is
 * the machine that sets a paper properly — columns, numbered headings and
 * figures, a real bibliography — and where `typst` is installed that is what
 * runs. This file is what happens on a box where it is not: the paper is
 * MARKDOWN, which is the real artefact and the thing stored beside the row,
 * and the PDF is that markdown rendered by the same headless Chrome the
 * screenshots already use. It is a readable document with numbered citations.
 * It is not a typeset paper, nothing here calls it one, and the row records
 * `chrome` so nothing downstream can call it one either.
 *
 * DELETING IT WOULD HAVE MADE THE FEATURE DEPEND ON A BINARY, which is the
 * trade this file was originally written to avoid: a run that shelled out to
 * something that is not there fails every time on the machine it runs on. Two
 * machines and an honest label is a better answer than one machine and a
 * prerequisite.
 *
 * THE HTML IS BUILT BY FORTY LINES IN THIS FILE for the reason scout.ts gives
 * about its Atom parsing: this server has one dependency and a markdown
 * library would be a second, a lockfile entry and a supply chain, to render
 * headings, paragraphs, lists, emphasis, code and links. What is NOT supported
 * is stated rather than silently mangled — tables, footnotes, images and raw
 * HTML pass through as the literal text they were written as, because a
 * renderer that half-renders a table produces something worse than one that
 * shows it plainly.
 *
 * EVERYTHING IS ESCAPED FIRST AND MARKED UP SECOND. The input is a language
 * model's output written to a file the owner will open in a browser; a `<script>`
 * in a paper's abstract must arrive as five visible characters.
 *
 * CHROME DOES NOT EXIT, and how that is handled — wait for the FILE to appear
 * and stop growing, then kill the browser on purpose — lives in
 * tools/chrome.ts along with the launcher itself.
 *
 * THE PROFILE DIRECTORY USED TO LEAK, ONE PER PAPER, FOR EVER. This file named
 * it `chrome-profile/paper-<id>` and deleted it never, so a box that had
 * printed four hundred papers carried four hundred Chrome profiles — and
 * because the name was stable, two prints of the same paper contended for the
 * same `ProcessSingleton` lock, which is the failure the venture capture had
 * already hit and written up. `withProfile` is mkdtemp and a `finally`: it
 * cleans up on the way out of a success and on the way out of a throw, and
 * there is no line here for a future caller to forget.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { baseArgs, findBrowser, shoot, withProfile } from "../../tools/chrome.ts";

export const PAPERS_DIR = resolve(DATA_DIR, "papers");

/** The whole render's wall clock. A paper is a few pages; a browser still
 *  going after this has not been slow, it has gone wrong. */
const RUN_MS = 60_000;
/** How long the page may keep loading before the PDF is taken. Ten seconds is
 *  generous for a local file with no network in it, and it is what this has
 *  always allowed. */
const VIRTUAL_MS = 10_000;

/* ------------------------------------------------------------- markdown */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline marks, applied to text that is ALREADY escaped. Code spans first, so
 *  a backtick span containing asterisks is not emphasised inside. */
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: "ul" | "ol" | null = null;
  let fence: string[] | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(esc(para.join(" ")))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (fence !== null) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`);
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      fence = [];
      continue;
    }

    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(esc(heading[2]!))}</h${level}>`);
      continue;
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push("<hr>");
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const number = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || number) {
      flushPara();
      const want = bullet ? "ul" : "ol";
      if (list !== want) {
        flushList();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${inline(esc((bullet ?? number)![1]!))}</li>`);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(esc(quote[1]!))}</blockquote>`);
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  if (fence !== null) out.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`);
  flushPara();
  flushList();
  return out.join("\n");
}

/** The printable page. Serif at eleven points with a measure that fits an A4
 *  column, because this is going to paper rather than to a screen. */
export function paperHtml(title: string, md: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 22mm 20mm; }
  html { font-size: 11pt; }
  body { font-family: Georgia, "Times New Roman", serif; line-height: 1.5; color: #16150f; }
  h1 { font-size: 1.7rem; line-height: 1.25; margin: 0 0 1rem; }
  h2 { font-size: 1.15rem; margin: 1.6rem 0 .5rem; border-bottom: 1px solid #ddd8cc; padding-bottom: .2rem; }
  h3 { font-size: 1rem; margin: 1.2rem 0 .35rem; }
  p, li { orphans: 3; widows: 3; }
  ul, ol { padding-left: 1.3rem; }
  li { margin: .2rem 0; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .85em; background: #f3f1ea; padding: .1em .3em; border-radius: 3px; }
  pre { background: #f3f1ea; padding: .7rem .9rem; border-radius: 6px; overflow-wrap: break-word; white-space: pre-wrap; }
  pre code { background: none; padding: 0; }
  blockquote { margin: .8rem 0; padding-left: .9rem; border-left: 3px solid #ddd8cc; color: #4a4842; }
  a { color: #16150f; }
  hr { border: 0; border-top: 1px solid #ddd8cc; margin: 1.5rem 0; }
</style></head>
<body>
${markdownToHtml(md)}
</body></html>`;
}

/* ------------------------------------------------------------------ print */

export type PrintResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Write the markdown, the HTML beside it, and print the PDF.
 *
 * The three files share a name so a directory listing of DATA_DIR/papers is
 * self-explanatory, and the HTML is KEPT rather than written to a temporary
 * file: it is what the PDF was made from, it costs a few kilobytes, and when a
 * PDF comes out looking wrong it is the only way to tell a bad render from a
 * bad document.
 */
export function writePaperFiles(id: string, title: string, md: string): { md: string; html: string } {
  mkdirSync(PAPERS_DIR, { recursive: true });
  const mdPath = resolve(PAPERS_DIR, `${id}.md`);
  const htmlPath = resolve(PAPERS_DIR, `${id}.html`);
  writeFileSync(mdPath, md, "utf8");
  writeFileSync(htmlPath, paperHtml(title, md), "utf8");
  return { md: mdPath, html: htmlPath };
}

export async function printPdf(id: string, htmlPath: string): Promise<PrintResult> {
  const browser = findBrowser();
  if (!browser.found) return { ok: false, error: browser.error };

  const out = resolve(PAPERS_DIR, `${id}.pdf`);
  const res = await withProfile(
    (profile) =>
      shoot({
        bin: browser.path,
        args: [
          ...baseArgs({ profile, virtualTimeMs: VIRTUAL_MS, timeoutMs: RUN_MS, printing: true }),
          `--print-to-pdf=${out}`,
          `file://${htmlPath}`,
        ],
        out,
        budgetMs: RUN_MS,
      }),
    "paper-",
  );
  return res.ok ? { ok: true, path: res.path } : { ok: false, error: res.error };
}
