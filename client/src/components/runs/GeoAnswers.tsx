import { useApi } from "@/hooks/useApi";
import { ago } from "@/lib/live";
import { cn } from "@/lib/utils";
import { runsApi, type GeoAnswer } from "@/lib/api/runs";
import type { Venture } from "@/lib/store";

/**
 * WHAT THE MODELS ALREADY BELIEVE ABOUT THIS BUSINESS.
 *
 * The GEO run asks the active provider a handful of plain questions with NO
 * TOOLS AND NO WEB — "What is X?", "What does this host do?", "Recommend a tool
 * for this category" — and keeps the answers. The point is not to find out
 * anything true; it is to find out what a model says to somebody who asks it
 * about you, which is now a real distribution channel and is invisible from
 * every analytics product on this box.
 *
 * THREE PILLS, AND THEY ARE THREE DIFFERENT KINDS OF CLAIM.
 *
 *   MENTIONED is mechanical and certain: the venture's name or its host
 *   appeared in the answer, decided by string presence and nothing cleverer.
 *   It is the only one of the three this box can be sure of.
 *
 *   ACCURATE and RECOMMENDED are one model's judgement of another model's
 *   answer, and they are NULL when that judgement was not made. Null is drawn
 *   as "not judged" — a hollow pill — and never as a no. The distinction is
 *   the whole reason there are three pills instead of a score out of ten: a
 *   composite would silently turn "nobody checked" into "it failed".
 *
 * THE ANSWERS THEMSELVES ARE ON SCREEN, not just the scores. A pill saying a
 * model was inaccurate is worth nothing without the sentence it was inaccurate
 * in — that sentence is the thing you would go and try to correct on the open
 * web, and it is the only actionable output the run has.
 */
export function GeoAnswers({
  venture,
  refreshKey,
}: {
  venture: Venture | null;
  /** The id of the run that just settled — see `RunApp`'s `extras`. */
  refreshKey: string;
}) {
  const doc = useApi(
    () => (venture ? runsApi.geo(venture.id) : Promise.resolve(null)),
    [venture?.id ?? null, refreshKey],
  );

  if (!venture)
    return (
      <p className="text-muted-foreground text-[13px]">
        Pick a venture to see what the models say about it.
      </p>
    );

  const answers = doc.data?.answers ?? [];

  /* Grouped by provider, then drawn newest first inside each — the question is
     "what does THIS model say", and interleaving two providers' answers to the
     same question makes that the hardest thing on the page to read. */
  const byProvider = new Map<string, GeoAnswer[]>();
  for (const a of answers) {
    const list = byProvider.get(a.provider);
    if (list) list.push(a);
    else byProvider.set(a.provider, [a]);
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
          What the models say
        </div>
        <span className="text-muted-foreground ml-auto text-[11.5px]">
          {doc.loading && !doc.data
            ? "loading…"
            : doc.error
              ? doc.error
              : answers.length === 0
                ? "nothing asked yet"
                : `${answers.length} ${answers.length === 1 ? "answer" : "answers"} · ${byProvider.size} ${
                    byProvider.size === 1 ? "provider" : "providers"
                  }`}
        </span>
      </div>

      {answers.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">
          Nothing has been asked about {venture.name} yet. A run puts the same
          few questions to the active provider with no tools and no web, and
          keeps whatever comes back.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {[...byProvider].map(([provider, rows]) => (
            <div key={provider}>
              <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
                <span className="text-[13px] font-medium tracking-tight">
                  {provider}
                </span>
                <span className="text-muted-foreground text-[11.5px]">
                  {rows[0]?.model ?? "model not recorded"} · asked{" "}
                  {ago(rows[0]?.ts ?? null)} ·{" "}
                  {rows.filter((r) => r.mentioned).length} of {rows.length}{" "}
                  mentioned it
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {rows.map((a, i) => (
                  <div
                    key={`${a.runId}:${i}`}
                    className="bg-card rounded-[10px] border p-3"
                  >
                    <div className="mb-1 flex flex-wrap items-baseline gap-2">
                      <span className="text-[12.5px] font-medium tracking-tight">
                        {a.question}
                      </span>
                      <span className="ml-auto flex shrink-0 gap-1">
                        <Pill label="mentioned" value={a.mentioned} />
                        <Pill label="accurate" value={a.accurate} />
                        <Pill label="recommended" value={a.recommended} />
                      </span>
                    </div>
                    <p className="text-muted-foreground text-[12.5px] leading-relaxed whitespace-pre-wrap">
                      {a.answer}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Filled for yes, outlined-and-struck for no, hollow and dashed for a
 *  judgement nobody made. Three states because there are three. */
function Pill({ label, value }: { label: string; value: boolean | null }) {
  return (
    <span
      title={
        value === null
          ? `${label}: not judged — no second turn scored this answer`
          : value
            ? label
            : `not ${label}`
      }
      className={cn(
        "rounded-[6px] border px-1.5 py-px text-[10.5px] leading-[1.5] whitespace-nowrap",
        value === null && "text-muted-foreground border-dashed opacity-70",
        value === true && "text-ok border-ok/40",
        value === false && "text-muted-foreground",
      )}
    >
      {value === null ? `${label}?` : value ? label : `no ${label}`}
    </span>
  );
}
