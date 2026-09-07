import { useState } from "react";
import { Loader2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SubTabs } from "@/components/TabStrip";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/hooks/useApi";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { day } from "@/lib/format";
import {
  nurtureApi,
  type Enrollment,
  type Identity,
  type NurtureDoc,
  type Sequence,
  type StyleDoc,
} from "@/lib/api/nurture";

/**
 * NURTURE — four tabs over the one thing this area does: WRITE.
 *
 * NOTHING ON THIS PAGE CAN SEND ANYTHING, and the page says so at the top
 * rather than leaving it to be inferred from the absence of a button. A
 * sequence step becomes a card in the Outbox; the Outbox is where a person
 * approves it and sends it, in two presses, as it always was.
 *
 * THE THREE STATES A ROW CAN BE IN, drawn apart because folding any two of them
 * together is a lie the eye will not catch:
 *
 *   ACTIVE   — in a sequence, waiting for its next step to come due.
 *   HELD     — a stop condition could not be checked today (Gmail refused, no
 *              account connected), so NOTHING was written for that person. It
 *              is not stopped, it resumes on its own, and the reason is shown.
 *   STOPPED  — a condition fired. The reason names which and what the evidence
 *              was, and it is kept forever.
 *
 * AN IDENTITY'S `verified: null` IS ITS OWN STATE. It means Resend has not been
 * asked, which is not "unverified" — a page that showed both as one would send
 * the owner to fix a domain that is fine.
 */

const TABS = ["sequences", "enrollments", "identities", "style"] as const;
type Tab = (typeof TABS)[number];


/**
 * A state pill. FOUR TONES, AND THEY ARE THE SHARED ONES.
 *
 * This drew its own border-tinted pill while two other areas drew a
 * background-tinted one and a third drew a filled badge, so "ok" was three
 * colour languages for one idea. The tone names stay — they are what this
 * page's twelve call sites read as — and the drawing is `Badge`.
 */
const TONE = { ok: "ok", warn: "warn", bad: "destructive", muted: "outline" } as const;

function Tag({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return <Badge variant={TONE[tone]}>{children}</Badge>;
}

/* ------------------------------------------------------------- sequences */

function SequenceCard({ seq, onChanged }: { seq: Sequence; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const cands = useApi(() => nurtureApi.candidates(seq.id), [seq.id, seq.enrolKind]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card border-line-soft mb-3 rounded-xl p-4.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[14.5px] font-medium">{seq.name}</span>
        {seq.enabled ? <Tag tone="ok">enabled</Tag> : <Tag tone="muted">off</Tag>}
        <Tag tone="muted">enrols: {seq.enrolKind}</Tag>
        {seq.ventureName && <Tag tone="muted">{seq.ventureName}</Tag>}
      </div>
      <div className="text-muted-foreground mt-1 text-[12.5px]">
        {seq.counts.active} active · {seq.counts.held} held · {seq.counts.stopped} stopped ·{" "}
        {seq.counts.done} finished · stops on {seq.stopOn.join(", ") || "nothing but its last step"} · at
        most {seq.dailyCap} drafts a day
      </div>

      <ol className="mt-2.5 space-y-1">
        {seq.steps.map((s, i) => (
          <li key={i} className="text-[13.5px]">
            <span className="text-muted-foreground">
              day {s.dayOffset} after enrolment ·{" "}
            </span>
            {s.purpose}
          </li>
        ))}
      </ol>

      {seq.problems.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {seq.problems.map((p, i) => (
            <li key={i} className="text-warn text-[13px]">
              Cannot draft: {p}
            </li>
          ))}
        </ul>
      )}

      {cands.data && cands.data.items.length > 0 && (
        <p className="text-muted-foreground mt-2.5 text-[12.5px]">
          The next pass would enrol {cands.data.items.length}:{" "}
          {cands.data.items.slice(0, 3).map((c) => c.address).join(", ")}
          {cands.data.items.length > 3 && " …"}
        </p>
      )}

      {error && <p role="alert" className="text-destructive mt-2 text-[13.5px]">{error}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant={seq.enabled ? "ghost" : "outline"}
          disabled={busy}
          onClick={() => void run(() => nurtureApi.patchSequence(seq.id, { enabled: !seq.enabled }))}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          {seq.enabled ? "Switch off" : "Switch on"}
        </Button>
        <Input
          aria-label={`Enrol somebody in ${seq.name}`}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="somebody@example.com"
          className="h-8 max-w-[240px] text-[13.5px]"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !address.includes("@")}
          onClick={() => void run(async () => { await nurtureApi.enrol(seq.id, address.trim()); setAddress(""); })}
        >
          Enrol
        </Button>
      </div>
    </div>
  );
}

function NewSequence({ doc, onCreated }: { doc: NurtureDoc; onCreated: () => void }) {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [venture, setVenture] = useState("");
  const [kind, setKind] = useState("manual");
  const [steps, setSteps] = useState("0 | Introduce yourself and ask what they are trying to do\n3 | Ask whether they got anywhere, and offer to help\n10 | A last note, and say you will leave it there");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Write a sequence
      </Button>
    );

  return (
    <section className="bg-card border-line-soft mb-4 space-y-3 rounded-xl p-5">
      <h2 className="text-[14.5px] font-medium">A new sequence</h2>
      <label className="block text-[13.5px]">
        Name
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Welcome" />
      </label>
      <label className="block text-[13.5px]">
        Venture
        <select
          aria-label="Venture"
          value={venture}
          onChange={(e) => setVenture(e.target.value)}
          className="border-line-soft mt-1 block w-full rounded border p-2 text-[13.5px]"
        >
          <option value="">No venture</option>
          {state.ventures.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>
      </label>
      <label className="block text-[13.5px]">
        Who joins it
        <select
          aria-label="Enrolment kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="border-line-soft mt-1 block w-full rounded border p-2 text-[13.5px]"
        >
          {doc.enrolKinds.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <span className="text-muted-foreground mt-1 block text-[12.5px]">
          signup, trial and churned are read from a product's own users document — the `users` plugin. With
          none connected they enrol nobody, and the sequence says so. `manual` means you (or the agent) add
          people by hand.
        </span>
      </label>
      <label className="block text-[13.5px]">
        Steps — one per line, <span className="font-mono">day | what that message is for</span>
        <Textarea rows={5} value={steps} onChange={(e) => setSteps(e.target.value)} className="text-[13.5px]" />
        <span className="text-muted-foreground mt-1 block text-[12.5px]">
          The day is counted from ENROLMENT, not from the previous step. The purpose is the wording model's
          whole brief and it joins the fact packet as your own words — so a figure you put here is a figure
          the letter may repeat.
        </span>
      </label>
      {error && <p role="alert" className="text-destructive text-[13.5px]">{error}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !name.trim() || !steps.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await nurtureApi.createSequence({
                name: name.trim(),
                venture: venture || null,
                enrolKind: kind,
                steps: steps
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => {
                    const [day, ...rest] = line.split("|");
                    return { dayOffset: Number(day?.trim()) || 0, purpose: rest.join("|").trim() };
                  }),
              });
              setOpen(false);
              setName("");
              onCreated();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : null} Create, switched off
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      <p className="text-muted-foreground text-[12.5px]">
        It is created switched OFF. A sequence that started enrolling people the moment it was typed would
        draft its first step before anybody had read the steps.
      </p>
    </section>
  );
}

/* ----------------------------------------------------------- enrollments */

function Enrollments() {
  const [status, setStatus] = useState("");
  const doc = useApi(() => nurtureApi.enrollments(status ? { status } : {}), [status]);
  const [busy, setBusy] = useState<number | null>(null);

  return (
    <>
          <div className="mb-3 flex flex-wrap gap-1">
            {["", "active", "stopped", "done"].map((s) => (
              <button
                key={s || "all"}
                onClick={() => setStatus(s)}
                className={cn(
                  "rounded-lg border px-2.5 py-1 text-[13.5px]",
                  status === s ? "bg-muted border-border" : "border-line-soft hover:bg-muted/50",
                )}
              >
                {s || "Everyone"}
              </button>
            ))}
            <button className="text-muted-foreground ml-auto text-[13.5px] underline" onClick={doc.reload}>
              Refresh
            </button>
          </div>
          {doc.error && <p role="alert" className="text-destructive text-[14px]">{doc.error}</p>}
          {doc.data?.items.length === 0 && (
            <p className="text-muted-foreground text-[14px]">Nobody is in a sequence in this view.</p>
          )}
          {doc.data?.items.map((e: Enrollment) => (
            <div key={e.id} className="bg-card border-line-soft mb-2 rounded-xl p-4">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[14px]">{e.name ? `${e.name} · ${e.address}` : e.address}</span>
                {e.status === "active" && !e.blocked && <Tag tone="ok">active</Tag>}
                {e.status === "active" && e.blocked && <Tag tone="warn">held</Tag>}
                {e.status === "stopped" && <Tag tone="muted">stopped</Tag>}
                {e.status === "done" && <Tag tone="muted">finished</Tag>}
                <span className="text-muted-foreground text-[12.5px]">{e.sequenceName}</span>
              </div>
              <div className="text-muted-foreground mt-0.5 text-[12.5px]">
                step {e.step} · enrolled {day(e.enrolledAt)}
                {e.nextDue && e.status === "active" && ` · next due ${day(e.nextDue)}`}
                {e.lastDraftAt && ` · last drafted ${day(e.lastDraftAt)}`}
              </div>
              {e.blocked && (
                <p className="text-warn mt-1.5 text-[13px]">
                  Held, and nothing was written: {e.blocked}. This is not a stop — it resumes on its own.
                </p>
              )}
              {e.stopReason && <p className="text-muted-foreground mt-1.5 text-[13px]">Stopped — {e.stopReason}</p>}
              {e.status === "active" && (
                <div className="mt-2 flex gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === e.id}
                    onClick={async () => {
                      setBusy(e.id);
                      try {
                        await nurtureApi.stop(e.id, "stopped from the Nurture page");
                        doc.reload();
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    Stop
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === e.id}
                    onClick={async () => {
                      if (!confirm(`Record that ${e.address} asked not to be written to again? This is permanent and covers every sequence, including ones written later.`)) return;
                      setBusy(e.id);
                      try {
                        await nurtureApi.optOut(e.address, "asked not to be written to");
                        doc.reload();
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    They asked to be left alone
                  </Button>
                </div>
              )}
              {e.history.length > 0 && (
                <details className="mt-2">
                  <summary className="text-muted-foreground cursor-pointer text-[12.5px]">
                    What happened ({e.history.length})
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {e.history.map((h, i) => (
                      <li key={i} className="text-muted-foreground text-[12.5px]">
                        {day(h.at)} — {h.what}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))}
          {doc.data && <p className="text-muted-foreground/70 mt-6 text-[12.5px]">{doc.data.note}</p>}
    </>
  );
}

/* ------------------------------------------------------------ identities */

function Identities({ doc, onChanged }: { doc: NurtureDoc; onChanged: () => void }) {
  const { state } = useStore();
  const options = useApi(() => nurtureApi.identityOptions(), []);
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"resend" | "gmail">("resend");
  const [accountId, setAccountId] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [fromName, setFromName] = useState("");
  const [venture, setVenture] = useState("");

  const tone = (i: Identity): "ok" | "warn" | "muted" =>
    i.verified === "verified" || i.verified === "mailbox" ? "ok" : i.verified === null ? "muted" : "warn";

  return (
    <>
      {doc.identities.map((i) => (
        <div key={i.id} className="bg-card border-line-soft mb-2 rounded-xl p-4">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[14px]">{i.fromName ? `${i.fromName} <${i.fromAddress}>` : i.fromAddress}</span>
            <Tag tone="muted">{i.kind}</Tag>
            <Tag tone={tone(i)}>{i.verified ?? "not asked"}</Tag>
            {i.isDefault && <Tag tone="ok">default</Tag>}
            {i.ventureName && <Tag tone="muted">{i.ventureName}</Tag>}
          </div>
          {i.verifyNote && <p className="text-muted-foreground mt-1 text-[12.5px]">{i.verifyNote}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === i.id}
              onClick={async () => {
                setBusy(i.id);
                setError(null);
                try {
                  await nurtureApi.verifyIdentity(i.id);
                  onChanged();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === i.id ? <Loader2 className="animate-spin" /> : <RefreshCw />} Ask Resend again
            </Button>
            {!i.isDefault && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => { await nurtureApi.makeDefault(i.id); onChanged(); }}
              >
                <ShieldCheck /> Make the default
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                setError(null);
                try {
                  await nurtureApi.deleteIdentity(i.id);
                  onChanged();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              <Trash2 /> Remove
            </Button>
          </div>
        </div>
      ))}

      <section className="bg-card border-line-soft mt-4 space-y-3 rounded-xl p-5">
        <h2 className="text-[14.5px] font-medium">A new sending identity</h2>
        <div className="flex gap-1">
          {(["resend", "gmail"] as const).map((k) => (
            <button
              key={k}
              onClick={() => { setKind(k); setAccountId(""); }}
              className={cn(
                "rounded-lg border px-2.5 py-1 text-[13.5px]",
                kind === k ? "bg-muted border-border" : "border-line-soft hover:bg-muted/50",
              )}
            >
              {k}
            </button>
          ))}
        </div>
        <label className="block text-[13.5px]">
          {kind === "resend" ? "Which Resend key (one per sending domain)" : "Which Gmail account"}
          <select
            aria-label="Account"
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              if (kind === "gmail") {
                const found = options.data?.gmail.find((g) => String(g.id) === e.target.value);
                if (found?.address) setFromAddress(found.address);
              }
            }}
            className="border-line-soft mt-1 block w-full rounded border p-2 text-[13.5px]"
          >
            <option value="">Choose one</option>
            {(kind === "resend" ? (options.data?.resend ?? []) : (options.data?.gmail ?? [])).map((a) => (
              <option key={a.id} value={a.id}>
                {"domain" in a ? a.domain : (a.address ?? a.label)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[13.5px]">
          From address
          <Input
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            placeholder={kind === "resend" ? "hello@yourdomain.com" : "the mailbox's own address"}
            disabled={kind === "gmail"}
          />
        </label>
        <label className="block text-[13.5px]">
          Display name
          <Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Your product" />
        </label>
        <label className="block text-[13.5px]">
          Venture
          <select
            aria-label="Identity venture"
            value={venture}
            onChange={(e) => setVenture(e.target.value)}
            className="border-line-soft mt-1 block w-full rounded border p-2 text-[13.5px]"
          >
            <option value="">No venture</option>
            {state.ventures.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </label>
        {error && <p role="alert" className="text-destructive text-[13.5px]">{error}</p>}
        <Button
          size="sm"
          disabled={busy === "new" || !accountId || !fromAddress.includes("@")}
          onClick={async () => {
            setBusy("new");
            setError(null);
            try {
              await nurtureApi.createIdentity({
                kind,
                accountId: Number(accountId),
                fromAddress,
                fromName,
                venture: venture || null,
                isDefault: true,
              });
              setFromAddress("");
              setFromName("");
              onChanged();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "new" ? <Loader2 className="animate-spin" /> : null} Add, and ask Resend about it
        </Button>
        <p className="text-muted-foreground text-[12.5px]">
          {options.data?.note ??
            "A Gmail identity may only claim the mailbox's own address. A Resend key here is scoped to one sending domain."}
        </p>
      </section>
    </>
  );
}

/* ----------------------------------------------------------------- style */

function Style() {
  const doc = useApi<StyleDoc>(() => nurtureApi.style(), []);
  const [rule, setRule] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = doc.data;

  return (
    <>
      {doc.error && <p role="alert" className="text-destructive text-[14px]">{doc.error}</p>}
      {d && !d.on && (
        <p className="text-muted-foreground mb-4 text-[14px]">
          Style learning is off. Switch it on under Integrations → Nurture to have your edits read into a few
          rules about wording. Nothing is stored while it is off.
        </p>
      )}
      {d && (
        <>
          <p className="text-muted-foreground mb-3 text-[12.5px]">
            {d.edits.count} edited draft{d.edits.count === 1 ? "" : "s"} on file
            {d.edits.newest && `, newest ${day(d.edits.newest)}`}. The pairs quote whole email bodies and are
            never shown here or sent anywhere but the derivation.
          </p>
          {d.rules.length === 0 && (
            <p className="text-muted-foreground text-[14px]">No rules yet.</p>
          )}
          {d.rules.map((r) => (
            <div key={r.id} className="bg-card border-line-soft mb-2 flex items-center gap-2 rounded-xl p-4">
              <span className="flex-1 text-[14px]">{r.rule}</span>
              {r.byOwner ? <Tag tone="ok">yours</Tag> : <Tag tone="muted">read from {r.evidence.length} edits</Tag>}
              <Button size="sm" variant="ghost" onClick={async () => { await nurtureApi.removeRule(r.id); doc.reload(); }}>
                <Trash2 />
              </Button>
            </div>
          ))}
          {d.refusals.length > 0 && (
            <details className="mt-3">
              <summary className="text-muted-foreground cursor-pointer text-[13px]">
                Rules that were refused ({d.refusals.length})
              </summary>
              <ul className="mt-1 space-y-0.5">
                {d.refusals.map((r) => (
                  <li key={r.id} className="text-muted-foreground text-[12.5px]">
                    “{r.rule}” — {r.why}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <Input
              aria-label="A rule of your own"
              value={rule}
              onChange={(e) => setRule(e.target.value)}
              placeholder="keep the greeting to one word"
              className="h-8 max-w-[320px] text-[13.5px]"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !rule.trim()}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await nurtureApi.addRule(rule.trim());
                  setRule("");
                  doc.reload();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add a rule
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const out = await nurtureApi.derive();
                  if (out.error) setError(out.error);
                  doc.reload();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Loader2 className="animate-spin" /> : null} Read my edits again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (!confirm("Forget every rule, every refusal and every stored before/after pair?")) return;
                await nurtureApi.forget();
                doc.reload();
              }}
            >
              Forget the voice
            </Button>
          </div>
          {error && <p role="alert" className="text-destructive mt-2 text-[13.5px]">{error}</p>}
          <p className="text-muted-foreground/70 mt-6 text-[12.5px] leading-relaxed">{d.note}</p>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ page */

export function Nurture() {
  const [tab, setTab] = useState<Tab>("sequences");
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState<string | null>(null);
  const doc = useApi<NurtureDoc>(() => nurtureApi.doc(), []);
  const d = doc.data;

  return (
    <PageShell
      title="Nurture"
      sub={
        <>
          Sequences that WRITE. A step that comes due becomes a draft in the Outbox with the facts that
          justify it printed beside it — and stays there until you approve and send it. Nothing on this page
          can send anything.
        </>
      }
    >
      {d && (
        <p className="text-muted-foreground mb-4 text-[12.5px] leading-relaxed">
          The daily pass runs at {String(d.settings.hour).padStart(2, "0")}:00 · at most{" "}
          {d.settings.draftsPerPass} drafts a pass · at most {d.settings.maxActive} people in sequences at
          once · the Outbox lets {d.settings.outboxDailyCap} messages leave a day and keeps one message per
          address per {d.settings.outboxGapDays} days ·{" "}
          {d.settings.styleLearning ? "style learning is on" : "style learning is off"}
          {d.passes[0] &&
            ` · last pass ${d.passes[0].day}: ${d.passes[0].enrolled} enrolled, ${d.passes[0].drafted} drafted, ${d.passes[0].stopped} stopped`}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-1">
        <SubTabs
          tabs={TABS.map((t) => ({ key: t, label: t }))}
          activeKey={tab}
          onSelect={(k) => setTab(k as Tab)}
          className="mb-0 capitalize"
        />
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={running}
          onClick={async () => {
            setRunning(true);
            try {
              const out = await nurtureApi.run(false);
              setRan(out.note);
              doc.reload();
            } catch (err) {
              setRan(err instanceof Error ? err.message : String(err));
            } finally {
              setRunning(false);
            }
          }}
        >
          {running ? <Loader2 className="animate-spin" /> : null} Run today's pass
        </Button>
      </div>

      {ran && <p className="text-muted-foreground mb-3 text-[13.5px]">{ran}</p>}
      {doc.error && (
        <p className="text-muted-foreground mb-4 text-[14px]">
          Nurture could not be read. <span className="text-destructive">{doc.error}</span>
        </p>
      )}
      {doc.loading && !d && (
        <p className="text-muted-foreground text-[14px]">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
          Reading the sequences.
        </p>
      )}

      {d && tab === "sequences" && (
        <>
          <NewSequence doc={d} onCreated={doc.reload} />
          {d.sequences.length === 0 && (
            <p className="text-muted-foreground mt-3 text-[14px]">
              No sequences yet. One is a name, a venture and a few steps; every step it produces is a draft.
            </p>
          )}
          <div className="mt-3">
            {d.sequences.map((s) => (
              <SequenceCard key={s.id} seq={s} onChanged={doc.reload} />
            ))}
          </div>
        </>
      )}
      {tab === "enrollments" && <Enrollments />}
      {d && tab === "identities" && <Identities doc={d} onChanged={doc.reload} />}
      {tab === "style" && <Style />}

      {d && tab === "sequences" && d.optouts.length > 0 && (
        <details className="mt-6">
          <summary className="text-muted-foreground cursor-pointer text-[13px]">
            People who asked to be left alone ({d.optouts.length})
          </summary>
          <ul className="mt-1 space-y-0.5">
            {d.optouts.map((o) => (
              <li key={o.address} className="text-muted-foreground text-[12.5px]">
                {o.address} — {day(o.at)}
                {o.reason && ` · ${o.reason}`}
              </li>
            ))}
          </ul>
        </details>
      )}

      {d && <p className="text-muted-foreground/70 mt-8 text-[12.5px] leading-relaxed">{d.note}</p>}
    </PageShell>
  );
}
