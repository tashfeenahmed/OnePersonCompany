import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, ImageOff, Loader2, RefreshCw, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { studioApi, type StudioPost } from "@/lib/api/studio";
import { publishingApi } from "@/areas/publishing/api";

/**
 * ONE POST, AS THE THING IT WILL BE WHEN IT IS PASTED SOMEWHERE.
 *
 * The picture, then the words, then the hashtags — the order they appear in on
 * every platform this is written for. Everything else on the card is evidence
 * or an action, and is drawn quieter than both.
 *
 * A POST WITH NO PICTURE IS STILL A POST and is drawn as one. The server will
 * happily store a caption with an `error` where the image should be (no
 * Replicate token, a prediction that did not finish), and the honest drawing
 * of that is the caption at full size with a stated reason in the picture's
 * place — not a broken image, not a spinner that never resolves, and not the
 * whole card greyed out as though the words were worthless.
 *
 * THE SWATCHES COME OUT OF THE PROMPT, NOT OFF THE VENTURE. The venture's
 * palette is whatever the site reads as TODAY; the colours this post was made
 * with are the ones written into the prompt at the moment it was made, and
 * `imagePrompt` still carries them verbatim. Reading them back out is the only
 * way the card can claim "made with these" and be right about a post from
 * before the site was restyled.
 */

/** Every six-digit hex in the prompt, in the order the prompt names them:
 *  primary, secondary, accent, then the background after "on". */
function swatches(prompt: string | null): string[] {
  if (!prompt) return [];
  return [...prompt.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]);
}

/**
 * The prompt, folded into one grey line — the same weight ToolCallLine gives a
 * tool call, and for the same reason. It is not what the post SAYS; it is what
 * was said to the model in order to get it, so it belongs present, skippable
 * and one line tall. The whole line is the toggle and carries `aria-expanded`;
 * there is no chevron, because the chevron would be a second control for the
 * only thing that can be done here.
 */
function PromptLine({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent -mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline rounded-[9px] px-1.5 py-0.5 text-left text-[13.5px] leading-[1.6] transition-colors"
      >
        <span className="min-w-0 truncate">
          The image was asked for like this
        </span>
        <span className="shrink-0">{" · "}{prompt.length} characters</span>
      </button>
      {open && (
        <p className="text-muted-foreground border-line-soft mt-1 ml-1.5 border-l pl-3 text-[13.5px] leading-[1.6] break-words whitespace-pre-wrap">
          {prompt}
        </p>
      )}
    </div>
  );
}

export function PostCard({
  post,
  palette,
  onChanged,
  onDeleted,
}: {
  post: StudioPost;
  /** The venture's palette as it reads NOW, shown only when the prompt
   *  carried no colours of its own. */
  palette?: string[];
  onChanged: (post: StudioPost) => void;
  onDeleted: (id: string) => void;
}) {
  const [busy, setBusy] = useState<"caption" | "image" | "delete" | "send" | null>(null);
  /* What the publishing queue said. A sentence rather than a redirect: this
     card is in a gallery somebody is scrolling, and being thrown onto another
     page for pressing a button on one card would lose their place. */
  const [sent, setSent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [armed, setArmed] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  /* A regenerated image lands at the same URL as the old one, which the
     browser is caching for an hour. The counter is what makes the <img> ask
     again — `ms` alone would repeat if two runs took the same millisecond. */
  const [version, setVersion] = useState(0);

  const made = swatches(post.imagePrompt);
  const colours = made.length ? made : (palette ?? []);
  const fromPrompt = made.length > 0;

  async function regenerate(what: "caption" | "image") {
    setBusy(what);
    setRefused(null);
    try {
      const res = await studioApi.regenerate(post.id, what);
      onChanged(res.post);
      setVersion((v) => v + 1);
      if (res.error) setRefused(res.error);
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    try {
      await studioApi.remove(post.id);
      onDeleted(post.id);
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
      setBusy(null);
      setArmed(false);
    }
  }

  /**
   * File this post into the publishing queue, as a DRAFT.
   *
   * NO DESTINATION IS CHOSEN HERE, deliberately. Which account a post goes to
   * is a decision with an audience attached, and the queue is where that is
   * made — with the destination's capabilities and the platform's limits on
   * screen. This button only says "keep this one".
   */
  async function sendToPublishing() {
    setBusy("send");
    setRefused(null);
    setSent(null);
    try {
      const res = await publishingApi.queue({
        sourceKind: "studio_post",
        sourceId: post.id,
      });
      setSent(res.note);
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    const text = [post.caption ?? "", post.hashtags.join(" ")]
      .filter(Boolean)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setRefused("This browser would not give the page the clipboard.");
    }
  }

  return (
    <div className="bg-card overflow-hidden rounded-[14px]">
      {/* The picture, on the muted ground rather than the card's own, so a
          PNG with a white background does not bleed into the card edge. */}
      {post.image ? (
        <img
          src={`${post.image}?v=${post.ms ?? 0}-${version}`}
          alt={`The image made for: ${post.brief}`}
          className="bg-muted max-h-[420px] w-full object-contain"
        />
      ) : (
        <div className="bg-muted text-muted-foreground flex items-center gap-2 px-3.5 py-6 text-[13.5px]">
          <ImageOff className="size-4 shrink-0" strokeWidth={1.6} />
          <span>
            {busy === "image"
              ? "Making a picture — Replicate holds the line for up to a minute."
              : "No picture on this post."}
          </span>
        </div>
      )}

      <div className="grid gap-2 px-3.5 py-3">
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
          <span>{when(post.ts)}</span>
          <span>·</span>
          <span>{post.format}</span>
          {post.platform && (
            <>
              <span>·</span>
              <span>{post.platform}</span>
            </>
          )}
          {post.model && (
            <>
              <span>·</span>
              <span className="min-w-0 truncate">{post.model}</span>
            </>
          )}
          {post.ms !== null && (
            <>
              <span>·</span>
              {/* Time, and said as time. Replicate publishes no price in its
                  API, so nothing here can turn this into money. */}
              <span title="Wall clock. Not a cost — Replicate publishes no price in its API.">
                {(post.ms / 1000).toFixed(1)}s
              </span>
            </>
          )}
        </div>

        <p className="text-[14.5px] leading-relaxed break-words whitespace-pre-wrap">
          {post.caption ?? (
            <span className="text-muted-foreground">
              The model answered with no caption.
            </span>
          )}
        </p>

        {post.hashtags.length > 0 && (
          <p className="text-muted-foreground text-[13.5px] break-words">
            {post.hashtags.join(" ")}
          </p>
        )}

        {colours.length > 0 && (
          <div className="text-muted-foreground flex items-center gap-1.5 text-[12.5px]">
            <span className="flex gap-1">
              {colours.slice(0, 4).map((hex, i) => (
                <span
                  key={`${hex}-${i}`}
                  title={hex}
                  className="border-line-soft size-[13px] rounded-[4px] border"
                  style={{ background: hex }}
                />
              ))}
            </span>
            <span>
              {fromPrompt
                ? "the colours this was made with"
                : "the venture's colours as they read now — this post's prompt named none"}
            </span>
          </div>
        )}

        {post.imagePrompt && <PromptLine prompt={post.imagePrompt} />}

        {/* THE SERVER'S OWN SENTENCE, not a status word. It is one string
            covering both halves because that is how the server joins it. */}
        {post.error && (
          <p className="text-warn text-[13.5px] leading-relaxed">{post.error}</p>
        )}
        {refused && (
          <p className="text-destructive text-[13.5px] leading-relaxed">
            {refused}
          </p>
        )}
        {sent && (
          <p className="text-muted-foreground text-[13.5px] leading-relaxed">
            {sent}{" "}
            <Link to="/social/publishing" className="underline decoration-dotted">
              Open the queue
            </Link>
            .
          </p>
        )}

        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? (
              <Check className="size-3.5" strokeWidth={2} />
            ) : (
              <Copy className="size-3.5" strokeWidth={1.8} />
            )}
            {copied ? "Copied" : "Copy caption"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void regenerate("caption")}
          >
            {busy === "caption" ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <RefreshCw className="size-3.5" strokeWidth={1.8} />
            )}
            Regenerate caption
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void regenerate("image")}
          >
            {busy === "image" ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <RefreshCw className="size-3.5" strokeWidth={1.8} />
            )}
            Regenerate image
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void sendToPublishing()}
          >
            {busy === "send" ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <Send className="size-3.5" strokeWidth={1.8} />
            )}
            Send to publishing
          </Button>
          {/* Two clicks, no dialog. The picture is gone off the disk with the
              row, so it is worth arming — and a modal for one line of text is
              furniture. */}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => (armed ? void remove() : setArmed(true))}
            onBlur={() => setArmed(false)}
            className={cn(
              "ml-auto",
              armed
                ? "text-destructive hover:text-destructive hover:bg-destructive/10"
                : "text-muted-foreground",
            )}
          >
            <Trash2 className="size-3.5" strokeWidth={1.8} />
            {armed ? "Delete it and the picture" : "Delete"}
          </Button>
        </div>
      </div>
    </div>
  );
}
