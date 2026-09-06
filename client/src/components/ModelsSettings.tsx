/**
 * MODELS — WHICH PROVIDER COMPLETES, AND WHAT ITS POLICY IS.
 *
 * WHY THIS LIVES IN SETTINGS AND THE PICKER LIVES IN THE CHAT HEADER, rather
 * than one of the two. They answer two different questions and the app already
 * splits them this way for the agents:
 *
 *   the Chat header   "who is answering me, right now" — a one-click switch
 *                     beside the composer that is about to spend one, exactly
 *                     where the agent selector already is.
 *   Settings → Models "what have I got, and how is each one set up" — four
 *                     providers, their endpoints, their policies, and the
 *                     sentence saying which one every agent inherits. That is
 *                     a page you read, not a control you reach for mid-chat.
 *
 * Putting the whole table in the chat header would be a dropdown with four
 * policies in it; putting the switch only in Settings would mean leaving a
 * conversation to change which model is answering it.
 *
 * THE POLICY ITSELF IS EDITED ON EACH PROVIDER'S OWN PAGE, and this shows it
 * read-only with a link. The controls belong beside the endpoints they govern
 * — "least-busy across these two boxes" means nothing without the two boxes on
 * screen — and a second set of editable controls here would be a second place
 * for the same value to be half-typed.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { api, type ModelProvider, type ProviderReply, type ProviderId } from "@/lib/api";
import { GATE_POLL_MS } from "@/components/ModelPolicy";
import { ToolModeNote } from "@/areas/runtime/ToolModeNote";
import { duration } from "@/lib/format";

/** The four, with the sentence that says what each one IS — because "local"
 *  and "openrouter" are ids rather than descriptions, and a page listing four
 *  ids makes the owner remember which is which. */
const ABOUT: Record<ProviderId, { name: string; note: string; page: string }> = {
  freellmapi: {
    name: "FreeLLMAPI",
    note: "The in-house catalog gateway — free-tier routing across many upstreams.",
    page: "/plugins/freellmapi",
  },
  local: {
    name: "Local models",
    note: "Ollama, LM Studio, vLLM — one account per endpoint, and they all answer.",
    page: "/plugins/local",
  },
  openai: {
    name: "OpenAI",
    note: "Needs its own inference key: the admin key that reads the bill cannot complete.",
    page: "/plugins/openai",
  },
  openrouter: {
    name: "OpenRouter",
    note: "Needs its own inference key: the management key that reads the bill cannot complete.",
    page: "/plugins/openrouter",
  },
};

function policyLine(p: ModelProvider): string {
  const how =
    p.policy.mode === "series"
      ? "one at a time"
      : `up to ${p.policy.concurrency} at once`;
  const where = p.endpoints > 1 ? `, ${p.policy.balance}` : "";
  const timeout = `, ${Math.round(p.policy.timeoutMs / 1000)}s timeout`;
  return `${how}${where}${timeout}${p.policyIsDefault ? " (default)" : ""}`;
}

export function ModelsSettings() {
  const doc = useApi(() => api.modelProviders(), []);
  const { reload } = doc;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /* Polled so the gate figures move while this is open — see ModelPolicy.tsx
     for why "in flight" and "queued" are what make a saved setting visible. */
  useEffect(() => {
    const t = setInterval(reload, GATE_POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  async function choose(id: ProviderId | null) {
    setBusy(true);
    setProblem(null);
    try {
      doc.setData(await api.setModelProvider(id));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (doc.error)
    return (
      <p className="text-muted-foreground py-5 text-[13.5px]">
        The API did not answer, so there is nothing to say about providers.{" "}
        <span className="text-destructive">{doc.error}</span>
      </p>
    );

  const providers = doc.data?.providers ?? [];
  const chosen = doc.data?.chosen ?? null;

  return (
    <div className="grid gap-3 py-5">
      <div>
        <div className="text-[14px] font-medium tracking-tight">
          The default provider
        </div>
        <p className="text-muted-foreground mt-0.5 max-w-[560px] text-[13.5px]">
          One provider completes. Every agent spawned from here is pointed at
          it, so "which model" is decided once — and a chat with no agent in
          front of it talks to it directly. Choosing one that is not connected
          is allowed and does nothing until its credentials are in.
        </p>
      </div>

      {doc.data?.why && (
        <p className="text-muted-foreground max-w-[560px] text-[13.5px]">
          {doc.data.why}
        </p>
      )}

      {/* WHAT THE CHOSEN CONNECTION ACTUALLY GIVES — text, or tools. It sits
          directly under the sentence about which provider is live because it
          is the second half of that sentence: a chat with no agent in front of
          it can now READ this box's data, but only where the model has been
          measured to support function calling. See
          areas/runtime/ToolModeNote.tsx. */}
      <ToolModeNote />

      <div className="flex flex-col gap-2">
        {providers.map((p) => {
          const about = ABOUT[p.id];
          return (
            <button
              key={p.id}
              disabled={busy || !p.connected}
              onClick={() => void choose(p.id)}
              aria-pressed={p.default}
              className={cn(
                "bg-card rounded-[14px] border p-4.5 text-left transition-colors",
                p.default ? "border-foreground" : "hover:border-line-strong",
                !p.connected && "opacity-60",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <i
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    p.live ? "bg-ok" : p.connected ? "bg-border" : "bg-border",
                  )}
                />
                <span className="text-[14px] font-medium">{about.name}</span>
                {/* THREE STATES, NOT TWO. Connected and not the default is the
                    middle one and is the common one — folding it into either
                    neighbour is how a page ends up saying "not connected"
                    about a key that is in the vault. */}
                <span className="text-muted-foreground text-[12.5px]">
                  {!p.connected
                    ? "not connected"
                    : p.default
                      ? "default"
                      : "ready, not the default"}
                </span>
                {p.default && <Check className="ml-auto size-3.5" strokeWidth={2} />}
              </div>

              <p className="text-muted-foreground mt-1 text-[12.5px] leading-snug">
                {about.note}
              </p>

              {p.connected && (
                <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
                  <span>
                    {p.endpoints} endpoint{p.endpoints === 1 ? "" : "s"}
                  </span>
                  <span>{policyLine(p)}</span>
                  <span>{p.model ? `model ${p.model}` : "model: whatever the endpoint lists first"}</span>
                  <span>
                    {p.gate.inFlight === 0 && p.gate.queued === 0
                      ? "idle"
                      : `${p.gate.inFlight} in flight${p.gate.queued ? ` · ${p.gate.queued} queued` : ""}`}
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {chosen && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void choose(null)}
            className="-ml-3 h-7 px-2 text-[13px]"
          >
            No default — nothing completes
          </Button>
        )}
        {problem && <span className="text-destructive text-[13px]">{problem}</span>}
      </div>

      <p className="text-muted-foreground text-[12.5px]">
        Endpoints, keys and each provider's policy are on its own page:{" "}
        {providers.map((p, i) => (
          <span key={p.id}>
            {i > 0 && ", "}
            <Link to={ABOUT[p.id].page} className="underline underline-offset-2">
              {ABOUT[p.id].name}
            </Link>
          </span>
        ))}
        .
      </p>

      <TestCompletion live={doc.data?.live ?? null} label={doc.data?.liveLabel ?? null} />
    </div>
  );
}

/**
 * One completion, down the same path everything else uses.
 *
 * IT IS NOT A MOCK AND IT IS NOT A PING. `POST /api/models/complete` goes
 * through `complete()` and therefore through the limiter, under whatever
 * policy is set — so this button proves the thing the owner actually cares
 * about ("can it answer") rather than the thing a health check proves ("is the
 * port open"). It writes no transcript row, which is the only difference
 * between it and sending the same words on the Chat page.
 *
 * The reply carries `queuedMs` beside `ms` and both are shown, because a
 * two-second answer that spent 1.9 of them waiting is a queue rather than a
 * slow model.
 */
function TestCompletion({ live, label }: { live: ProviderId | null; label: string | null }) {
  const [text, setText] = useState("Reply with one short sentence: are you there?");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ProviderReply | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setProblem(null);
    setReply(null);
    try {
      setReply(await api.complete(text));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-line-soft mt-2 border-t pt-4">
      <div className="text-[14px] font-medium tracking-tight">Ask it something</div>
      <p className="text-muted-foreground mt-0.5 mb-2.5 max-w-[560px] text-[13.5px]">
        {live
          ? `Goes to ${label}, through the same limiter every other completion goes through. Nothing is written to a transcript.`
          : "Nothing is the default, so this will come back with the server's own sentence saying so."}
      </p>
      <div className="flex max-w-[560px] flex-wrap items-center gap-2">
        <Input
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          className="min-w-[240px] flex-1 text-[13.5px]"
        />
        <Button size="sm" disabled={busy || !text.trim()} onClick={() => void send()}>
          <Send className="size-3.5" strokeWidth={1.8} />
          {busy ? "Asking…" : "Send"}
        </Button>
      </div>

      {problem && <p className="text-destructive mt-2 max-w-[560px] text-[13px]">{problem}</p>}

      {reply && (
        <div className="bg-card mt-2 max-w-[560px] rounded-[14px] border p-4.5">
          <p className="text-[14px] whitespace-pre-wrap">{reply.text.trim()}</p>
          <p className="text-muted-foreground mt-2 text-[12.5px]">
            {reply.provider} · {reply.endpoint}
            {reply.model && ` · ${reply.model}`} · {duration(reply.ms)}
            {reply.queuedMs > 0 && ` · queued ${duration(reply.queuedMs)}`}
            {reply.usage && ` · ${reply.usage.prompt + reply.usage.completion} tokens`}
          </p>
        </div>
      )}
    </div>
  );
}
