import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { AlertTriangle, Check, ExternalLink, Loader2, Pencil, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/hooks/useApi";
import { day } from "@/lib/format";
import {
  knowledgeApi,
  type FactKind,
  type FactTier,
  type RefreshResult,
} from "@/lib/api/knowledge";

/**
 * WHAT THIS PRODUCT IS, WITH THE EVIDENCE BESIDE EVERY SENTENCE.
 *
 * EVERY ROW SAYS WHERE IT CAME FROM AND WHEN. That is the whole design, and it
 * is the same one the memory tab keeps for the same reason: a bare list of
 * capabilities reads as a specification, and a specification is what somebody
 * quotes to a customer. A tiered list with a date and a file:line under each
 * line is something a person can check.
 *
 * THE TIER CHIP IS THE PRIMARY COLOUR ON THE PAGE. Owner is solid, repo is
 * outlined, measured is muted, and a proposal is drawn in the warning colour
 * with the word UNCONFIRMED in it — because the one failure mode that matters
 * here is a reader skimming a proposal as a fact.
 *
 * CORRECTING IS A TEXTAREA IN PLACE AND NOT A DIALOG. The owner is reading a
 * sentence that is wrong; the shortest path from noticing to fixing is the
 * sentence turning into an editable copy of itself. What it does underneath is
 * not an edit — the server files a new owner fact and marks the old one — and
 * the row says so afterwards.
 *
 * "REFRESH FROM REPO" SHOWS THE COMMIT IT LAST READ, always, next to the
 * button. A refresh button with no state beside it is a button somebody presses
 * twice; one that says "read at 4f21ab0, 2 days ago" answers the question that
 * made them reach for it.
 */

const TIER_STYLE: Record<FactTier, ComponentProps<typeof Badge>["variant"]> = {
  owner: "default",
  repo: "outline",
  measured: "secondary",
  proposed: "warn",
};

const KIND_LABEL: Record<FactKind, string> = {
  capability: "capability",
  pricing: "pricing",
  audience: "audience",
  integration: "integration",
  limitation: "limitation",
  metric: "metric",
  claim: "claim",
};

function ago(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

export function KnowledgeTab({ slug }: { slug: string }) {
  const [tier, setTier] = useState<FactTier | "">("");
  const [kind, setKind] = useState<FactKind | "">("");
  const doc = useApi(() => knowledgeApi.facts(slug, { tier, kind }), [slug, tier, kind]);
  const clashes = useApi(() => knowledgeApi.contradictions(slug), [slug]);

  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [newKind, setNewKind] = useState<FactKind>("capability");
  const [newText, setNewText] = useState("");
  const [repoDraft, setRepoDraft] = useState<string | null>(null);
  /* The two-step retire. A retire is irreversible — nothing on this box
     un-retires a fact — and it sat one click away from a Correct button of the
     same size. The row asks once. */
  const [retiring, setRetiring] = useState<string | null>(null);
  /* Set when a cheap refresh answered "HEAD has not moved", which is what
     offers the forced re-read. Without it the skip could never be seen: the
     button used to force every time and the skip branch was dead code. */
  const [unchanged, setUnchanged] = useState(false);

  const run = (what: string, p: Promise<unknown>, done?: (out: unknown) => string | null) => {
    setBusy(what);
    setFailure(null);
    setSaid(null);
    p.then((out) => setSaid(done ? done(out) : null))
      .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(null);
        doc.reload();
        clashes.reload();
      });
  };

  /*
    THE CHEAP REFRESH IS THE DEFAULT ONE.

    `force` skips the "HEAD has not moved and nothing has expired" test on the
    server, which is the whole of what makes this button cheap: without it every
    press spends a set of GitHub calls and a completion re-deriving facts that
    cannot have changed. The forced read is still one click away, and it appears
    only once the cheap one has said there was nothing to do.
  */
  const refresh = (force: boolean) => {
    setUnchanged(false);
    run("refresh", knowledgeApi.refresh(slug, force), (out) => {
      const r = out as RefreshResult;
      if (r.skipped) {
        setUnchanged(true);
        return r.skipped;
      }
      const drops = Object.entries(r.dropped ?? {});
      return (
        `${r.added} added, ${r.refreshed} refreshed, ${r.retired} retired from ` +
        `${r.filesRead} excerpt(s)${r.modelUsed ? ` with ${r.modelUsed}` : " with no model"}.` +
        (drops.length
          ? ` Dropped ${drops.reduce((n, [, v]) => n + v, 0)}: ${drops
              .map(([why, n]) => `${n}× ${why}`)
              .join("; ")}.`
          : "") +
        (r.notes?.length ? ` ${r.notes.join(" ")}` : "")
      );
    });
  };

  if (doc.error) return <p className="text-destructive p-4 text-[13.5px]">{doc.error}</p>;
  if (!doc.data)
    return <p className="text-muted-foreground p-4 text-[13.5px]">Reading what is known…</p>;

  const { facts, kinds, tiers, tierSays, repo, total, limits } = doc.data;
  const unresolved = clashes.data?.contradictions.filter((c) => !c.resolved) ?? [];

  return (
    <div className="flex flex-col gap-5 p-4.5">
      <p className="text-muted-foreground max-w-3xl text-[12.5px]">
        What this product IS, as opposed to what it measures. Every line carries
        the tier it came from and the date it was observed. For what the product
        does, the owner beats the repository beats a connected account; for a
        number, the measurement beats everything. The agent is given this list on
        every conversation about this venture — minus the proposals, which are
        never handed to a model as context.
      </p>

      {/* ------------------------------------------------------ the repository */}
      <div className="border-line-soft bg-card flex flex-wrap items-center gap-2 rounded-[10px] border p-3">
        {repoDraft === null ? (
          <>
            <span className="text-[13px]">
              {repo?.repo ? (
                <>
                  Repository <span className="font-medium">{repo.repo}</span>
                  <span className="text-muted-foreground">
                    {repo.kind === "local" ? " (a checkout on this machine)" : ""}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  No repository is mapped to this venture, so there are no facts read
                  out of its source.
                </span>
              )}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setRepoDraft(repo?.repo ?? "")}>
              <Pencil className="size-3.5" strokeWidth={1.6} />
              {repo?.repo ? "Change" : "Set one"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !repo?.repo}
              onClick={() => refresh(false)}
            >
              {busy === "refresh" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" strokeWidth={1.6} />
              )}
              Refresh from repo
            </Button>
            {/* Only after a skip, which is the only moment it means anything.
                A permanent "force" button beside a cheap one is two buttons
                that look the same and cost differently. */}
            {unchanged && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => refresh(true)}
              >
                Read it anyway
              </Button>
            )}
            <span className="text-muted-foreground text-[11.5px]">
              {repo?.head
                ? `read at ${repo.head.slice(0, 7)}${
                    repo.extractedAt ? `, ${day(repo.extractedAt)}` : ""
                  }`
                : repo?.repo
                  ? "never read"
                  : ""}
              {repo?.via ? ` · ${repo.via}` : ""}
            </span>
          </>
        ) : (
          <>
            <Input
              value={repoDraft}
              onChange={(e) => setRepoDraft(e.target.value)}
              placeholder="owner/name, or an absolute path on this machine"
              className="h-8 max-w-md text-[13px]"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !repoDraft.trim()}
              onClick={() => {
                run("repo", knowledgeApi.setRepo(slug, repoDraft.trim()));
                setRepoDraft(null);
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRepoDraft(null)}>
              Cancel
            </Button>
            <span className="text-muted-foreground text-[11.5px]">
              “owner/name” reads it through GitHub; a path starting with “/” reads a
              checkout on this machine. Nothing from either is ever executed.
            </span>
          </>
        )}
      </div>

      {repo?.error && (
        <p className="text-destructive text-[12.5px]">{repo.error}</p>
      )}
      {failure && <p className="text-destructive text-[12.5px]">{failure}</p>}
      {said && <p className="text-muted-foreground text-[12.5px]">{said}</p>}

      {/* ---------------------------------------------------- contradictions */}
      {unresolved.length > 0 && (
        <div className="border-warn/40 bg-warn/10 rounded-[10px] border p-3">
          <p className="flex items-center gap-1.5 text-[13px] font-medium">
            <AlertTriangle className="size-3.5" strokeWidth={1.6} />
            {unresolved.length} pair{unresolved.length === 1 ? "" : "s"} of facts disagree
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {unresolved.map((c, i) => (
              <li key={i} className="text-[12.5px]">
                <span className="text-muted-foreground">{c.reason}</span>
                <div className="mt-1 flex flex-col gap-0.5">
                  <span>
                    <TierChip tier={c.a.tier} /> {c.a.statement}
                  </span>
                  <span>
                    <TierChip tier={c.b.tier} /> {c.b.statement}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ------------------------------------------------------------ filters */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip on={tier === ""} onClick={() => setTier("")}>
          All tiers
        </Chip>
        {tiers.map((t) => (
          <Chip key={t} on={tier === t} onClick={() => setTier(t)} title={tierSays[t]}>
            {t}
          </Chip>
        ))}
        <span className="mx-1.5" />
        <Chip on={kind === ""} onClick={() => setKind("")}>
          All kinds
        </Chip>
        {kinds.map((k) => (
          <Chip key={k} on={kind === k} onClick={() => setKind(k)}>
            {KIND_LABEL[k]}
          </Chip>
        ))}
        <span className="text-muted-foreground ml-auto text-[11.5px]">
          {facts.length} shown of {total} on file
        </span>
      </div>

      {/* -------------------------------------------------------- the facts */}
      {facts.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">
          Nothing on file under this filter. That is an absence of evidence, not
          evidence that the product is simple.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {facts.map((f) => (
            <li key={f.id} className="border-line-soft bg-card rounded-[10px] border p-3">
              {editing === f.id ? (
                <div className="flex flex-col gap-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={2}
                    maxLength={limits.maxStatement}
                    className="text-[13px]"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null || !draft.trim()}
                      onClick={() => {
                        run("correct", knowledgeApi.correct(f.id, draft.trim()), (out) =>
                          (out as { inPlace?: boolean; note?: string }).note ?? null,
                        );
                        setEditing(null);
                      }}
                    >
                      Save as the owner's
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <span className="text-muted-foreground text-[11.5px]">
                      The old sentence is kept and marked corrected, pointing at this one.
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start gap-2">
                    <TierChip tier={f.tier} />
                    <span className="text-[13.5px]">{f.statement}</span>
                  </div>
                  <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px]">
                    <span>{KIND_LABEL[f.kind]}</span>
                    <span>·</span>
                    <span>observed {ago(f.ageDays)}</span>
                    <span>·</span>
                    {f.source.url ? (
                      <a
                        href={f.source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2"
                      >
                        {f.source.ref}
                        <ExternalLink className="size-3" strokeWidth={1.6} />
                      </a>
                    ) : (
                      <span>{f.source.ref}</span>
                    )}
                    {f.source.commit && <span>· at {f.source.commit.slice(0, 7)}</span>}
                    {f.stale && <span className="text-warn">· past its refresh date</span>}
                    <span className="ml-auto flex items-center gap-1">
                      {f.tier === "proposed" && (
                        <button
                          disabled={busy !== null}
                          onClick={() => run("confirm", knowledgeApi.confirm(f.id))}
                          className="hover:text-foreground inline-flex items-center gap-1"
                        >
                          <Check className="size-3.5" strokeWidth={1.6} />
                          Confirm
                        </button>
                      )}
                      <button
                        disabled={busy !== null}
                        onClick={() => {
                          setEditing(f.id);
                          setDraft(f.statement);
                        }}
                        className="hover:text-foreground inline-flex items-center gap-1"
                      >
                        <Pencil className="size-3.5" strokeWidth={1.6} />
                        Correct
                      </button>
                      {retiring === f.id ? (
                        <>
                          <button
                            disabled={busy !== null}
                            onClick={() => {
                              run("retire", knowledgeApi.retire(f.id, "retired by the owner"));
                              setRetiring(null);
                            }}
                            className="text-destructive inline-flex items-center gap-1"
                          >
                            <X className="size-3.5" strokeWidth={1.6} />
                            Retire for good
                          </button>
                          <button
                            onClick={() => setRetiring(null)}
                            className="hover:text-foreground inline-flex items-center gap-1"
                          >
                            Keep it
                          </button>
                        </>
                      ) : (
                        <button
                          disabled={busy !== null}
                          onClick={() => setRetiring(f.id)}
                          className="hover:text-destructive inline-flex items-center gap-1"
                        >
                          <X className="size-3.5" strokeWidth={1.6} />
                          Retire
                        </button>
                      )}
                    </span>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* ------------------------------------------------------ the owner's own */}
      <div className="border-line-soft bg-card rounded-[10px] border p-4">
        <p className="mb-2 text-[13px] font-medium">Write one yourself</p>
        <div className="flex flex-wrap items-center gap-1.5 pb-2">
          {kinds.map((k) => (
            <Chip key={k} on={newKind === k} onClick={() => setNewKind(k)}>
              {KIND_LABEL[k]}
            </Chip>
          ))}
        </div>
        <Textarea
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          rows={2}
          maxLength={limits.maxStatement}
          placeholder="One sentence about the product — what it does, what it costs, what it cannot do. The owner's tier beats everything the machine read."
          className="text-[13px]"
        />
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !newText.trim()}
            onClick={() => {
              run("add", knowledgeApi.add(slug, newKind, newText.trim()));
              setNewText("");
            }}
          >
            Record it
          </Button>
          <span className="text-muted-foreground text-[11.5px]">
            Nothing here is ever deleted; retiring and correcting keep the old
            sentence with the date it stopped being current.
          </span>
        </div>
      </div>

    </div>
  );
}

function TierChip({ tier }: { tier: FactTier }) {
  return (
    <Badge variant={TIER_STYLE[tier]} className="text-[10.5px] tracking-wide uppercase">
      {tier === "proposed" ? "unconfirmed" : tier}
    </Badge>
  );
}

function Chip({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded-full px-2 py-0.5 text-[11.5px] ${
        on ? "bg-foreground text-background" : "border-line-soft text-muted-foreground hover:text-foreground border"
      }`}
    >
      {children}
    </button>
  );
}
