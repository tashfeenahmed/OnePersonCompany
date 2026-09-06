/**
 * A fenced block, with the one control that matters. Split out of Markdown.tsx
 * because RichBlock falls back to it when a widget's JSON does not parse.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";

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
export function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="border-line-soft bg-muted/40 relative my-2.5 rounded-[14px] border">
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
        className="text-muted-foreground hover:bg-accent hover:text-foreground absolute top-1.5 right-1.5 grid place-items-center rounded-[9px] p-1.5 transition-colors"
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
      <pre className="overflow-x-auto px-3.5 py-3 pr-11 text-[13px] leading-[1.55]">
        <code className="font-mono">{text}</code>
      </pre>
    </div>
  );
}
