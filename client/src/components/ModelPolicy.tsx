/**
 * THE LOAD-BALANCING POLICY, AS FOUR CONTROLS AND A LIVE READOUT.
 *
 * It is a settings block rather than a dashboard card because it is the one
 * thing on these pages that CHANGES the machine's behaviour rather than
 * describing it: series or parallel, how many at once, which endpoint next,
 * and how long to wait. The server owns the rules — models/policy.ts refuses a
 * concurrency of 0 and a two-second timeout with a sentence each — and this
 * shows the refusal rather than duplicating the check, for the reason every
 * credential form here shows the provider's own words: a second copy of a rule
 * is a second thing to get out of step.
 *
 * WHY THE GATE READOUT SITS BESIDE THE CONTROLS AND NOT ON A DASHBOARD. "In
 * flight" and "queued" are the only way to tell that a setting DID something.
 * A concurrency raised from 1 to 4 looks identical to a concurrency that was
 * never saved, until four calls are in flight instead of one and the queue is
 * empty. It is polled while the panel is open, and the poll is cheap by
 * construction: the server answers it without decrypting anything.
 *
 * TWO NUMBERS RATHER THAN ONE, and it is the same distinction `queuedMs`
 * carries on every reply: "the model is slow" and "the queue is long" are
 * different complaints with different fixes, and a single "busy" figure
 * covering both would send the owner to buy a GPU when the answer was to raise
 * a number.
 */
import { useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { api, type ModelPolicy, type ModelProvider, type ProviderId } from "@/lib/api";

/** How often the gate is re-read while a panel is open. Two seconds is fast
 *  enough that a completion fired from another tab is visible and slow enough
 *  that a page left open overnight is a few thousand indexed reads rather than
 *  a busy loop. */
export const GATE_POLL_MS = 2_000;

const MODES: { id: ModelPolicy["mode"]; label: string; note: string }[] = [
  {
    id: "series",
    label: "Series",
    note: "One at a time. The right default for a single GPU — two completions at once halve the speed of both and can run the card out of memory.",
  },
  {
    id: "parallel",
    label: "Parallel",
    note: "Up to the concurrency below. What a hosted API wants, and what two local boxes want.",
  },
];

const BALANCES: { id: ModelPolicy["balance"]; label: string; note: string }[] = [
  {
    id: "round-robin",
    label: "Round-robin",
    note: "The next endpoint in order, busy or not.",
  },
  {
    id: "least-busy",
    label: "Least-busy",
    note: "Whichever has the fewest calls in flight right now.",
  },
];

export function PolicyControls({
  provider,
  onChanged,
}: {
  provider: ModelProvider;
  /** Called with the whole providers document the server answers with, so the
   *  page above can redraw every provider — changing one policy changes the
   *  gate figures nothing else was watching. */
  onChanged: (id: ProviderId) => void;
}) {
  const p = provider.policy;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /*
    THE TWO NUMERIC FIELDS ARE UNCONTROLLED, WITH A KEY OFF THE SERVER'S VALUE.

    A controlled input driven straight off the fetched document fights the
    owner for the caret: this panel polls every couple of seconds, and every
    poll would put the stored number back under a half-typed one. Holding a
    draft in state instead needs the draft RESET when the server's value
    changes — another tab, or this panel's own save — and doing that in an
    effect is a setState during render's aftermath, which is a cascading
    render and a lint warning that is right.

    So the field is uncontrolled and its `key` is the server's value. React
    remounts it — with the new number in it — exactly when that number changes,
    and leaves the draft alone the rest of the time. No effect, no second
    render, and the reset happens for the one reason it should.
  */
  const seconds = Math.round(p.timeoutMs / 1000);

  async function save(patch: Partial<ModelPolicy>) {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await api.setModelPolicy(provider.id, patch);
      setSaved(true);
      onChanged(provider.id);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await api.clearModelPolicy(provider.id);
      onChanged(provider.id);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label>How many at once</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              disabled={busy}
              onClick={() => void save({ mode: m.id })}
              aria-pressed={p.mode === m.id}
              className={cn(
                "bg-card rounded-[10px] border p-3 text-left transition-colors",
                p.mode === m.id ? "border-foreground" : "hover:border-line-strong",
              )}
            >
              <div className="flex items-center gap-2 text-[13px] font-medium">
                {m.label}
                {p.mode === m.id && <Check className="ml-auto size-3.5" strokeWidth={2} />}
              </div>
              <p className="text-muted-foreground mt-1 text-[11.5px] leading-snug">
                {m.note}
              </p>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${provider.id}-concurrency`}>Concurrency</Label>
          <Input
            key={`concurrency-${p.concurrency}`}
            id={`${provider.id}-concurrency`}
            inputMode="numeric"
            defaultValue={String(p.concurrency)}
            disabled={busy || p.mode === "series"}
            onBlur={(e) => {
              const n = Number(e.currentTarget.value);
              if (n !== p.concurrency) void save({ concurrency: n });
            }}
            className="font-mono text-[12.5px]"
          />
          <p className="text-muted-foreground text-[11px]">
            {p.mode === "series"
              ? "Ignored in series — series IS a ceiling of one."
              : "1 to 64. Not a limit of this box: the point past which a number is a typo."}
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={`${provider.id}-timeout`}>Timeout (seconds)</Label>
          <Input
            key={`timeout-${seconds}`}
            id={`${provider.id}-timeout`}
            inputMode="numeric"
            defaultValue={String(seconds)}
            disabled={busy}
            onBlur={(e) => {
              const n = Math.round(Number(e.currentTarget.value) * 1000);
              if (n !== p.timeoutMs) void save({ timeoutMs: n });
            }}
            className="font-mono text-[12.5px]"
          />
          <p className="text-muted-foreground text-[11px]">
            5 to 600. A local model warming up can take a while; past ten
            minutes a hung endpoint is holding a socket nobody is waiting on.
          </p>
        </div>
      </div>

      {/* THE BALANCE ONLY MEANS ANYTHING WITH SEVERAL ENDPOINTS, and with one
          it is drawn disabled with the reason rather than hidden. Hiding it
          would make "how do I spread across two boxes" a question with no
          visible answer until the second box exists. */}
      <div className="grid gap-1.5">
        <Label>Which endpoint takes the next call</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {BALANCES.map((b) => (
            <button
              key={b.id}
              disabled={busy || provider.endpoints < 2}
              onClick={() => void save({ balance: b.id })}
              aria-pressed={p.balance === b.id}
              className={cn(
                "bg-card rounded-[10px] border p-3 text-left transition-colors",
                p.balance === b.id ? "border-foreground" : "hover:border-line-strong",
                provider.endpoints < 2 && "opacity-55",
              )}
            >
              <div className="flex items-center gap-2 text-[13px] font-medium">
                {b.label}
                {p.balance === b.id && <Check className="ml-auto size-3.5" strokeWidth={2} />}
              </div>
              <p className="text-muted-foreground mt-1 text-[11.5px] leading-snug">
                {b.note}
              </p>
            </button>
          ))}
        </div>
        {provider.endpoints < 2 && (
          <p className="text-muted-foreground text-[11px]">
            One endpoint, so both rules pick the same one. This matters from the
            second endpoint onwards.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-[11.5px]">
          {provider.policyIsDefault
            ? `Nothing set — these are the defaults for ${provider.id}: ` +
              `${provider.policyDefaults.mode}, ${provider.policyDefaults.concurrency} at once.`
            : "Your settings, not the defaults."}
        </span>
        {!provider.policyIsDefault && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void reset()}
            className="h-7 px-2 text-[12px]"
          >
            <RotateCcw className="size-3.5" strokeWidth={1.8} />
            Back to the default
          </Button>
        )}
        {saved && !problem && (
          <span className="text-ok flex items-center gap-1.5 text-[12px]">
            <Check className="size-3.5" strokeWidth={2} />
            Saved
          </span>
        )}
        {problem && <span className="text-destructive text-[12px]">{problem}</span>}
      </div>
    </div>
  );
}

/**
 * What the limiter is doing this second.
 *
 * `inFlight` counts calls that have a slot; `queued` counts calls waiting for
 * one. A provider with a queue and a low concurrency is a provider whose
 * setting is the bottleneck; a provider with calls in flight and no queue and
 * slow replies is a slow model. The page can say which, which is the whole
 * point of reporting both.
 */
export function GateReadout({ provider }: { provider: ModelProvider }) {
  const { inFlight, queued } = provider.gate;
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-[11.5px]">
      <i
        className={cn(
          "size-1.5 rounded-full",
          queued > 0 ? "bg-warn" : inFlight > 0 ? "bg-ok" : "bg-border",
        )}
      />
      {inFlight === 0 && queued === 0
        ? "idle"
        : `${inFlight} in flight${queued ? ` · ${queued} queued` : ""}`}
    </span>
  );
}
