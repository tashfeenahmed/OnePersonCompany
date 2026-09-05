/**
 * AN AGENT'S ANSWER, RENDERED AS THE MARKDOWN IT ACTUALLY IS.
 *
 * Every model on the other end of this app writes markdown whether or not
 * anybody asked it to — headings, bullets, fenced code, `**bold**`, tables.
 * The Chat page used to draw that as `whitespace-pre-wrap`, which is not
 * neutral: it is a decision to show the owner the asterisks and the backticks
 * and let them do the parsing. A three-column table came out as a wall of
 * pipes.
 *
 * WHY A DEPENDENCY, WHICH IS THE ONE REAL DECISION HERE. `react-markdown` plus
 * `remark-gfm` is 4 npm packages of transitive weight in a project that has
 * been deliberate about every one. The alternative was a regex pass — bold,
 * code fences, links, done — and it is the wrong trade in a way that is worth
 * writing down, because it always looks like the right one for the first
 * afternoon:
 *
 *   — markdown is not a regular language. Nested lists, a fence inside a
 *     blockquote, a table whose cell contains a pipe in backticks: each is one
 *     more special case, and the twentieth one breaks the third.
 *   — a hand-rolled renderer that emits HTML is an XSS hole aimed at text that
 *     came from a MODEL, which is to say from whatever was in its context —
 *     including, on this app, the contents of the owner's mailbox and their
 *     Hetzner bill. That is the exact input you do not want to be writing your
 *     own sanitiser for.
 *   — a stream re-renders this on every delta. A parser that is correct and
 *     fast is a project; this one already is.
 *
 * SANITISATION IS BY OMISSION, NOT BY FILTERING. `react-markdown` builds React
 * elements and never touches `dangerouslySetInnerHTML`; raw HTML in the source
 * is passed through as TEXT unless `rehype-raw` is added, and it is not added
 * and must not be. There is nothing to sanitise because there is no HTML path
 * — which is a stronger guarantee than any allowlist, and the reason no
 * sanitiser is imported here.
 *
 * WHAT IS NOT RENDERED THIS WAY: the owner's own messages. Those stay plain
 * text with whitespace preserved, because a person who types `*` means an
 * asterisk, and a pasted stack trace that quietly becomes a bulleted list is
 * the interface editing what somebody said.
 */
import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A fenced block, with the one control that matters.
 *
 * COPY IS THE FEATURE, not syntax highlighting. Code in a chat exists to be
 * moved somewhere else, and the thing that goes wrong when you select it by
 * hand is picking up the leading spaces of the wrong line. Highlighting would
 * mean a second dependency an order of magnitude larger than the parser, for
 * colour.
 *
 * The confirmation is on the button for a second and a half. A copy that gives
 * no feedback is one people press twice.
 */
function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="border-line-soft bg-muted/40 relative my-2.5 rounded-[10px] border">
      <button
        onClick={() => {
          /*
            `navigator.clipboard` is undefined on an insecure origin that is
            not localhost. This app is only ever served from 127.0.0.1, so the
            case is theoretical — but a rejected promise here would be an
            unhandled rejection in the console rather than a button that
            visibly did nothing, and the catch costs one line.
          */
          void navigator.clipboard
            ?.writeText(text)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => setCopied(false));
        }}
        title="Copy"
        className="text-muted-foreground hover:bg-accent hover:text-foreground absolute top-1.5 right-1.5 grid place-items-center rounded-[7px] p-1.5 transition-colors"
      >
        {copied ? (
          <Check className="size-3.5" strokeWidth={2} />
        ) : (
          <Copy className="size-3.5" strokeWidth={1.6} />
        )}
      </button>
      {/* The scroll is on the block and never on the page. A 200-character
          line in an answer must not make the whole transcript scroll
          sideways. */}
      <pre className="overflow-x-auto px-3.5 py-3 pr-11 text-[12px] leading-[1.55]">
        <code className="font-mono">{text}</code>
      </pre>
    </div>
  );
}

/**
 * The element map.
 *
 * Every tag this can produce is styled explicitly rather than through a
 * typography plugin. That is more lines, and it is the right amount of
 * control: the page has one type scale (13.5px body, 11.5px meta) and a
 * `prose` class would bring its own, at which point an answer looks like it
 * came from a different application than the page around it.
 *
 * Defined outside the component so the object is not rebuilt on every render —
 * which, in a stream, is every delta.
 */
const COMPONENTS = {
  h1: (p: { children?: React.ReactNode }) => (
    <h1 className="mt-4 mb-1.5 text-[15px] font-medium tracking-tight first:mt-0">
      {p.children}
    </h1>
  ),
  h2: (p: { children?: React.ReactNode }) => (
    <h2 className="mt-4 mb-1.5 text-[14px] font-medium tracking-tight first:mt-0">
      {p.children}
    </h2>
  ),
  h3: (p: { children?: React.ReactNode }) => (
    <h3 className="mt-3.5 mb-1 text-[13.5px] font-medium tracking-tight first:mt-0">
      {p.children}
    </h3>
  ),
  h4: (p: { children?: React.ReactNode }) => (
    <h4 className="text-muted-foreground mt-3.5 mb-1 text-[13px] font-medium first:mt-0">
      {p.children}
    </h4>
  ),
  p: (p: { children?: React.ReactNode }) => (
    <p className="my-2 first:mt-0 last:mb-0">{p.children}</p>
  ),
  ul: (p: { children?: React.ReactNode }) => (
    <ul className="my-2 list-disc pl-5 first:mt-0 last:mb-0">{p.children}</ul>
  ),
  ol: (p: { children?: React.ReactNode }) => (
    <ol className="my-2 list-decimal pl-5 first:mt-0 last:mb-0">{p.children}</ol>
  ),
  li: (p: { children?: React.ReactNode }) => (
    <li className="my-0.5 pl-0.5">{p.children}</li>
  ),
  blockquote: (p: { children?: React.ReactNode }) => (
    <blockquote className="border-line-strong text-muted-foreground my-2.5 border-l-2 pl-3">
      {p.children}
    </blockquote>
  ),
  hr: () => <hr className="border-line-soft my-4" />,
  strong: (p: { children?: React.ReactNode }) => (
    <strong className="font-medium">{p.children}</strong>
  ),
  a: (p: { href?: string; children?: React.ReactNode }) => (
    /*
      A LINK IN AN ANSWER GOES SOMEWHERE THE MODEL CHOSE, so it leaves in a new
      tab and it leaves without a handle on this one. `noopener` is the load
      bearing half — without it the opened page gets `window.opener` and can
      navigate this tab somewhere else — and `noreferrer` keeps the dashboard's
      address out of the destination's logs.
    */
    <a
      href={p.href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
    >
      {p.children}
    </a>
  ),
  code: (p: { className?: string; children?: React.ReactNode }) => {
    /*
      INLINE OR FENCED, TOLD APART BY THE LANGUAGE CLASS AND THE NEWLINE.
      react-markdown v10 dropped the `inline` prop that used to answer this,
      and the replacement everybody reaches for — "is there a language-* class"
      — misses a fence with no language on it, which is most of them. A string
      containing a newline is not inline text; that is the second half of the
      test and it is what catches the bare ``` block.
    */
    const text = String(p.children ?? "");
    const fenced = /language-/.test(p.className ?? "") || text.includes("\n");
    if (fenced) return <CodeBlock text={text.replace(/\n$/, "")} />;
    return (
      <code className="bg-muted/60 rounded-[5px] px-1 py-px font-mono text-[12px]">
        {p.children}
      </code>
    );
  },
  /* The fence's wrapper. `code` above already drew the block, so this is a
     pass-through — a second <pre> around it would nest a scroll container in a
     scroll container. */
  pre: (p: { children?: React.ReactNode }) => <>{p.children}</>,
  /* GFM tables. The scroll is on a wrapper rather than the table so a wide one
     never widens the transcript column. */
  table: (p: { children?: React.ReactNode }) => (
    <div className="border-line-soft my-2.5 overflow-x-auto rounded-[10px] border">
      <table className="w-full border-collapse text-[12.5px]">{p.children}</table>
    </div>
  ),
  thead: (p: { children?: React.ReactNode }) => (
    <thead className="border-line-soft border-b">{p.children}</thead>
  ),
  th: (p: { children?: React.ReactNode }) => (
    <th className="px-3 py-1.5 text-left font-medium">{p.children}</th>
  ),
  td: (p: { children?: React.ReactNode }) => (
    <td className="border-line-soft border-t px-3 py-1.5 align-top">{p.children}</td>
  ),
  img: (p: { src?: string; alt?: string }) => (
    /* Rendered, but never wider than the column. An answer that quotes an
       image URL should not be able to blow the layout out. */
    <img src={p.src} alt={p.alt ?? ""} className="my-2 max-w-full rounded-[8px]" />
  ),
};

/**
 * MEMOISED ON THE TEXT, which is the whole performance story of streaming.
 *
 * A delta arrives every few tens of milliseconds and each one re-renders the
 * page. Without this, every other bubble in the transcript re-parses its
 * markdown on every chunk of the one being written — a 40-message conversation
 * re-parsing itself 300 times over one answer. With it, only the growing
 * message re-parses, which is the one that changed.
 *
 * The Chat page does the other half: it batches deltas into a single state
 * update per animation frame, so this re-parses at most 60 times a second no
 * matter how fast the agent writes.
 */
export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("text-[13.5px] leading-[1.6] break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
