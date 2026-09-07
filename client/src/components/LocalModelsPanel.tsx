/**
 * THE LOCAL MODELS PANEL — what each endpoint is serving, and the policy that
 * decides which of them takes the next call.
 *
 * It sits under the credentials on the Local models page, where the Telegram
 * bridge's panel sits under its bot token, and for the same reason: the
 * credential list answers "is this stored", and the thing the owner actually
 * came to find out is "is it working, and what is behind it".
 *
 * THE MODEL LIST IS FETCHED LIVE ON EVERY OPEN, never stored. A model is
 * pulled and deleted by a person at a terminal — `ollama pull`, a click in LM
 * Studio — so a catalog written down when the endpoint was connected is wrong
 * within a day, and wrong in the direction that matters: it would offer a
 * model that has been deleted and fail every completion with "model not
 * found".
 *
 * EACH ENDPOINT REPORTS ITS OWN FAILURE. A laptop that is closed shows its own
 * line saying so and takes nothing off the GPU box's row — the per-account
 * degradation every collector in this app keeps, in the one place where it is
 * most obviously right: these are literally different machines.
 *
 * AND THE GATE IS POLLED WHILE THIS IS OPEN. Without it, raising the
 * concurrency from 1 to 4 looks exactly like not having saved it. See
 * ModelPolicy.tsx.
 */
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import { useApi } from "@/hooks/useApi";
import { api, type ModelProvider, type ProviderId } from "@/lib/api";
import { cn } from "@/lib/utils";
import { GATE_POLL_MS, GateReadout, PolicyControls } from "@/components/ModelPolicy";

/** The providers document, re-read on a timer so the gate figures move. Shared
 *  by both panels below, because both want the same document and a page with
 *  two of them open should not fetch it twice. */
function useProviders() {
  const doc = useApi(() => api.modelProviders(), []);
  const { reload } = doc;
  useEffect(() => {
    const t = setInterval(reload, GATE_POLL_MS);
    return () => clearInterval(t);
  }, [reload]);
  return doc;
}

/** The line every one of these panels closes on: whether this provider is the
 *  one that actually answers, and where to change that. */
function DefaultLine({
  provider,
  chosen,
  onChoose,
}: {
  provider: ModelProvider;
  chosen: ProviderId | null;
  onChoose: () => void;
}) {
  if (provider.default)
    return (
      <p className="mt-4 text-[13.5px]">
        <span className="font-medium">This is the default provider.</span>{" "}
        <span className="text-muted-foreground">
          Every agent spawned here is pointed at it, and a chat with no agent in
          front of it talks to it directly.
        </span>
      </p>
    );
  return (
    <div className="mt-4 text-[13.5px]">
      <span className="font-medium">Connected, not the default.</span>{" "}
      <span className="text-muted-foreground">
        {chosen
          ? `${chosen} is what completes at the moment — one provider is the default at a time.`
          : "No provider is the default, so nothing completes until one is chosen."}
      </span>
      <button
        onClick={onChoose}
        className="hover:bg-accent border-line-strong mt-2 block rounded-lg border px-2.5 py-1 text-[13.5px]"
      >
        Make this the default provider
      </button>
    </div>
  );
}

export function LocalModelsPanel() {
  const providers = useProviders();
  const models = useApi(() => api.localModels(), []);

  const local = providers.data?.providers.find((p) => p.id === "local") ?? null;
  if (!local) return null;

  const choose = async (id: ProviderId | null) => {
    await api.setModelProvider(id);
    providers.reload();
  };

  return (
    <>
      <Separator className="mt-7 mb-5" />
      <div className="mb-3 flex items-center gap-2">
        <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
          Endpoints
        </div>
        <span className="ml-auto">
          <GateReadout provider={local} />
        </span>
      </div>

      {models.error && (
        <p className="text-destructive text-[13px]">{models.error}</p>
      )}

      <div className="flex flex-col gap-2">
        {(models.data?.endpoints ?? []).map((e) => {
          const inFlight =
            local.gate.byEndpoint.find((g) => g.baseUrl === e.baseUrl)?.inFlight ?? 0;
          return (
            <div key={e.accountId} className="bg-card rounded-[14px] p-4.5">
              <div className="flex flex-wrap items-center gap-2">
                <i
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    e.error ? "bg-destructive" : inFlight ? "bg-ok" : "bg-border",
                  )}
                />
                <span className="text-[14px] font-medium">{e.label}</span>
                <span className="text-muted-foreground font-mono text-[12.5px]">
                  {e.baseUrl}
                </span>
                <span className="text-muted-foreground ml-auto text-[12.5px]">
                  {/* A key or no key, never the key. A loopback runner with no
                      auth is the ordinary case and worth being able to see
                      without opening the vault. */}
                  {e.hasKey ? "bearer sent" : "no key"}
                  {inFlight ? ` · ${inFlight} in flight` : ""}
                </span>
              </div>

              {e.error ? (
                <p className="text-destructive mt-2 text-[12.5px] leading-snug">
                  {e.error}
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {e.models.length ? (
                    e.models.map((m) => (
                      <span
                        key={m}
                        className={cn(
                          "rounded-[8px] border px-1.5 py-0.5 font-mono text-[12px]",
                          m === models.data?.model
                            ? "border-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        {m}
                      </span>
                    ))
                  ) : (
                    <span className="text-muted-foreground text-[12.5px]">
                      This endpoint answered and listed no models.
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-muted-foreground mt-3 text-[12.5px]">
        {models.data?.model
          ? `Asking for ${models.data.model} — set under Settings above, and it has to exist on whichever endpoint takes the call.`
          : "No model named, so each endpoint is asked for whichever it lists first. That is a real answer read from the endpoint rather than a guess — name one under Settings above to pin it."}
      </p>

      <Separator className="mt-7 mb-5" />
      <div className="mb-3 flex items-center gap-2">
        <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
          Policy
        </div>
        <span className="text-muted-foreground ml-auto text-[12.5px]">
          {local.endpoints} endpoint{local.endpoints === 1 ? "" : "s"}
        </span>
      </div>

      <div className="max-w-[560px]">
        <PolicyControls provider={local} onChanged={() => providers.reload()} />
        <DefaultLine
          provider={local}
          chosen={providers.data?.chosen ?? null}
          onChoose={() => void choose("local")}
        />
        <p className="text-muted-foreground mt-3 text-[12.5px]">
          Every provider has its own policy, and they are all on{" "}
          <Link to="/settings" className="underline underline-offset-2">
            Settings → Models
          </Link>
          .
        </p>
      </div>
    </>
  );
}

/**
 * The same policy block, smaller, for a provider that is not primarily a model
 * provider.
 *
 * OpenAI and OpenRouter are cost integrations that CAN also complete, so their
 * pages lead with the bill and this is a section near the bottom. It draws
 * nothing at all when no inference key has been pasted — an empty policy panel
 * on a page whose owner only wants their spend chart would be a control for a
 * feature they have not switched on.
 */
export function ProviderPolicyPanel({ id }: { id: ProviderId }) {
  const providers = useProviders();
  const provider = providers.data?.providers.find((p) => p.id === id) ?? null;
  if (!provider?.connected) return null;

  const choose = async () => {
    await api.setModelProvider(id);
    providers.reload();
  };

  return (
    <>
      <Separator className="mt-7 mb-5" />
      <div className="mb-3 flex items-center gap-2">
        <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
          As a model provider
        </div>
        <span className="ml-auto">
          <GateReadout provider={provider} />
        </span>
      </div>

      <p className="text-muted-foreground mb-4 max-w-[560px] text-[13.5px]">
        The inference key is stored, so this can answer completions as well as
        report its bill. The two keys are separate on purpose and neither can do
        the other's job — see the credentials above.
      </p>

      <div className="max-w-[560px]">
        <PolicyControls provider={provider} onChanged={() => providers.reload()} />
        <DefaultLine
          provider={provider}
          chosen={providers.data?.chosen ?? null}
          onChoose={() => void choose()}
        />
      </div>
    </>
  );
}
