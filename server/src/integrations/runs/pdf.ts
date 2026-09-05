/**
 * MARKDOWN TO A PDF, WITH THE BROWSER THAT IS ALREADY ON THE BOX.
 *
 * TYPST IS NOT INSTALLED HERE AND THIS DOES NOT PRETEND OTHERWISE. The obvious
 * shape for a written paper is a typesetter: real figure numbering, real
 * bibliography styling, a document that looks like a paper because it was set
 * like one. That is not what this is. There is no Typst and no LaTeX on this
 * machine, installing either is a two-hundred-megabyte dependency the owner
 * did not ask for, and a run that shelled out to a binary that is not there
 * would fail every time on the one machine it runs on. So the honest shape is
 * the one the box can actually do: the paper is MARKDOWN, which is the real
 * artefact and the thing stored beside the row, and the PDF is that markdown
 * rendered by the same headless Chrome the screenshots already use. It is a
 * readable document with numbered citations. It is not a typeset paper and
 * nothing here calls it one.
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
 * CHROME DOES NOT EXIT, which capture.ts discovered and documented at length:
 * `--headless=new --print-to-pdf=…` writes a complete PDF and then sits there.
 * So this waits for the FILE — it appears, and its size stops changing between
 * two polls — and then kills the browser on purpose. That is not a failure and
 * is not reported as one.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { findBrowser } from "../ventures/capture.ts";

export const PAPERS_DIR = resolve(DATA_DIR, "papers");

const POLL_MS = 250;
/** The whole render's wall clock. A paper is a few pages; a browser still
 *  going after this has not been slow, it has gone wrong. */
const RUN_MS = 60_000;

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

export function printPdf(id: string, htmlPath: string): Promise<PrintResult> {
  const browser = findBrowser();
  if (!browser.found) return Promise.resolve({ ok: false, error: browser.error });

  const out = resolve(PAPERS_DIR, `${id}.pdf`);
  const profile = resolve(DATA_DIR, "chrome-profile", `paper-${id}`);
  mkdirSync(profile, { recursive: true });

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-crash-reporter",
    "--no-pdf-header-footer",
    "--virtual-time-budget=10000",
    `--user-data-dir=${profile}`,
    `--print-to-pdf=${out}`,
    `file://${htmlPath}`,
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");

  return new Promise<PrintResult>((done) => {
    const child = spawn(browser.path, args, { windowsHide: true });
    const deadline = Date.now() + RUN_MS;
    let settled = false;
    let lastSize = -1;
    let err = "";

    child.stderr.on("data", (b: Buffer) => {
      if (err.length < 8_192) err += b.toString("utf8");
    });

    const finish = (result: PrintResult) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done(result);
    };

    const timer = setInterval(() => {
      if (existsSync(out)) {
        let size = -1;
        try {
          size = statSync(out).size;
        } catch {
          /* being written */
        }
        /* A size that has not changed since the last poll AND is not zero is a
           file Chrome has finished with. One pass, like the PNG. */
        if (size > 0 && size === lastSize) return finish({ ok: true, path: out });
        lastSize = size;
      }
      if (Date.now() > deadline)
        finish({
          ok: false,
          error: `Chrome did not produce a PDF within ${Math.round(RUN_MS / 1000)} seconds${err.trim() ? ` — ${err.trim().split("\n")[0]}` : ""}.`,
        });
    }, POLL_MS);

    child.on("error", (e) => finish({ ok: false, error: `Could not start ${browser.path} — ${e.message}` }));
  });
}
