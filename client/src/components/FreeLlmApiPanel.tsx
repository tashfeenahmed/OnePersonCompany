import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useApi } from "@/hooks/useApi";
import { api, type FreeLlmApiAccount, type FreeLlmApiDoc } from "@/lib/api";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * FreeLLMAPI, under the credentials on its own plugin page.
 *
 * TWO WAYS IN, AND THE PANEL HAS TO HOLD BOTH AT ONCE. FreeLLMAPI is an
 * OpenAI-compatible gateway that fronts the providers with a free tier; there
 * is no hosted one to sign up for, so an instance is either somebody else's
 * machine (the credential form above this panel) or this one (the Install
 * button in it). Both end up as accounts of the same plugin, because they are
 * the same wire — and that is what makes switching a click rather than a
 * re-paste.
 *
 * THE THREE FACTS PEOPLE CONFUSE, KEPT APART:
 *
 *   INSTALLED  something is on disk under `data/freellmapi/`
 *   RUNNING    a child process is answering on 127.0.0.1:3001
 *   IN USE     a completion sent right now would go there
 *
 * All three can differ. A running local instance beside a deliberately chosen
 * hosted account is a legitimate state, and the panel says "running, and not
 * the one answering" rather than implying the words have moved.
 *
 * AND ONE MORE, WHICH IS THE MODELS PAGE'S: whether FreeLLMAPI is the DEFAULT
 * PROVIDER at all. A perfectly connected gateway with a local model chosen
 * over it completes nothing, and this is the page somebody is standing on when
 * they wonder why — so the button that fixes it is here, writing the same
 * setting that page writes.
 *
 * NO KEY IS DRAWN ANYWHERE. The managed instance mints its own and the server
 * reads it out of the gateway's database straight into the vault; the log tail
 * below is scrubbed on the server before it is even written to a file, because
 * that install deliberately prints the key to stdout once. `hasKey` is a
 * boolean and that is the whole of what this component knows.
 */
export function FreeLlmApiPanel() {
  const doc = useApi(() => api.freellmapi(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const data = doc.data;
  /*
    POLLED ONLY WHILE SOMETHING IS MOVING. An install is minutes and a start is
    seconds, and both change under the reader with nothing to click — but a
    settled panel asking every two seconds forever would ask the endpoint for
    its catalog on a timer nobody is watching. `reload` is stable per fetch
    closure, so the interval is torn down and rebuilt only when the state
    actually stops moving.
  */
  const moving =
    data?.instance.state === "installing" || data?.instance.state === "starting";
  const reload = doc.reload;
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(reload, 2000);
    return () => clearInterval(timer);
  }, [moving, reload]);

  if (doc.error || !data) return null;

  async function act(name: string, run: () => Promise<unknown>) {
    setBusy(name);
    setProblem(null);
    try {
      await run();
      doc.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  const i = data.instance;

  return (
    <>
      <Separator className="mt-7 mb-5" />
      <div className="text-muted-foreground mb-3 text-[11px] tracking-[0.06em] uppercase">
        Which endpoint answers
      </div>

      {data.accounts.length ? (
        <div className="flex flex-col gap-2">
          {data.accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              automatic={data.chosenAccountId === null}
              busy={busy === `use:${a.id}`}
              onUse={() => act(`use:${a.id}`, () => api.freellmapiUseAccount(a.id))}
            />
          ))}
          {data.chosenAccountId !== null && (
            <div className="flex items-center gap-2 text-[12px]">
              <span className="text-muted-foreground">
                One endpoint is pinned, so the local instance starting will not
                move the completions.
              </span>
              <Button
                variant="ghost"
                className="ml-auto h-7 px-2 text-[12px]"
                disabled={busy === "auto"}
                onClick={() => act("auto", () => api.freellmapiUseAccount(null))}
              >
                {busy === "auto" ? "Clearing…" : "Automatic"}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground text-[12px]">
          No endpoint yet. Paste the base URL and key of a FreeLLMAPI you
          already run above — there is no hosted one, so the address is always
          somebody's own — or install one here.
        </p>
      )}

      {/* THE DEFAULT-PROVIDER LINE. Connected and chosen are two different
          things, and only the second one makes a chat turn arrive here. */}
      <p className="mt-3 text-[12.5px]">
        {data.provider.isDefault ? (
          <span className="text-muted-foreground">
            FreeLLMAPI is the default provider — every agent completes through
            it, {data.provider.model ? `asking for ${data.provider.model}` : "letting the gateway route"}
            , {data.provider.policy.concurrency} calls at a time.
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-warn">
              Connected, and not the default provider — nothing completes
              through it yet.
            </span>
            {!!data.inUse && (
              <Button
                variant="outline"
                className="h-7 px-2.5 text-[12px]"
                disabled={busy === "default"}
                onClick={() => act("default", () => api.freellmapiMakeDefault())}
              >
                {busy === "default" ? "Setting…" : "Use as default provider"}
              </Button>
            )}
          </span>
        )}
      </p>

      {/* ---------------------------------------------------------- instance */}

      <Separator className="mt-7 mb-5" />
      <div className="text-muted-foreground mb-3 flex items-center gap-2 text-[11px] tracking-[0.06em] uppercase">
        <span>Instance on this machine</span>
        <StateDot state={i.state} />
      </div>

      <Instance instance={i} />

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {i.state === "absent" && (
          <Button
            className="h-8 px-3 text-[12.5px]"
            disabled={busy === "install"}
            onClick={() => act("install", () => api.freellmapiInstall())}
          >
            {busy === "install" ? "Starting the install…" : "Install here"}
          </Button>
        )}
        {(i.state === "installed" || i.state === "stopped" || i.state === "failed") && (
          <Button
            className="h-8 px-3 text-[12.5px]"
            disabled={busy === "start"}
            onClick={() => act("start", () => api.freellmapiStart())}
          >
            {busy === "start" ? "Starting…" : "Start"}
          </Button>
        )}
        {(i.state === "running" || i.state === "starting") && (
          <>
            <Button
              variant="outline"
              className="h-8 px-3 text-[12.5px]"
              disabled={busy === "stop"}
              onClick={() => act("stop", () => api.freellmapiStop())}
            >
              {busy === "stop" ? "Stopping…" : "Stop"}
            </Button>
            <Button
              variant="ghost"
              className="h-8 px-3 text-[12.5px]"
              disabled={busy === "reconnect"}
              onClick={() => act("reconnect", () => api.freellmapiReconnect())}
            >
              {busy === "reconnect" ? "Re-reading…" : "Re-read its key"}
            </Button>
          </>
        )}
        {i.state === "running" && i.dashboard && (
          <a
            className="text-muted-foreground hover:text-foreground text-[12px] underline underline-offset-2"
            href={i.dashboardUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open its dashboard →
          </a>
        )}
      </div>

      {problem && <p className="text-destructive mt-2.5 text-[12px]">{problem}</p>}
      {i.lastError && (
        <p
          className={cn(
            "mt-2.5 text-[12px] leading-snug",
            i.state === "failed" ? "text-destructive" : "text-warn",
          )}
        >
          {i.lastError}
        </p>
      )}

      {/* ------------------------------------------------------------ models */}

      {!!data.models.count && (
        <>
          <Separator className="mt-7 mb-5" />
          <div className="text-muted-foreground mb-3 text-[11px] tracking-[0.06em] uppercase">
            {data.models.count} models on {data.inUse?.label ?? "the endpoint"}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.models.ids.slice(0, 40).map((id) => (
              <span
                key={id}
                className="bg-muted/60 rounded-[6px] px-1.5 py-0.5 font-mono text-[11px]"
              >
                {id}
              </span>
            ))}
            {data.models.count > 40 && (
              <span className="text-muted-foreground py-0.5 text-[11px]">
                +{data.models.count - 40} more
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-2.5 text-[11.5px] leading-snug">
            Read from the endpoint itself, {ago(data.models.readAt)}. The first
            id is what an empty Model setting asks for — on this gateway that is
            its own router rather than a guess made here. The model that
            actually answered comes back on every reply, because it fails over
            between providers.
          </p>
        </>
      )}
      {data.models.error && (
        <p className="text-warn mt-2.5 text-[12px]">
          Its catalog could not be read: {data.models.error}
        </p>
      )}

      {/* The log tail, which during an install is the only honest thing to
          show for several minutes. Scrubbed on the server. */}
      {!!i.log.length && (i.state === "installing" || i.state === "failed") && (
        <pre className="bg-muted/50 mt-4 max-h-56 overflow-auto rounded-[8px] p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {i.log.slice(-24).join("\n")}
        </pre>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ pieces */

const STATE_WORD: Record<FreeLlmApiDoc["instance"]["state"], string> = {
  absent: "not installed",
  installing: "installing",
  installed: "installed, not running",
  starting: "starting",
  running: "running",
  stopped: "stopped",
  failed: "failed",
};

function StateDot({ state }: { state: FreeLlmApiDoc["instance"]["state"] }) {
  const bad = state === "failed";
  const quiet = state === "installing" || state === "starting" || state === "stopped";
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 normal-case",
        bad ? "text-destructive" : quiet ? "text-warn" : "text-muted-foreground",
      )}
    >
      <i
        className={cn(
          "size-1.5 rounded-full",
          bad ? "bg-destructive" : quiet ? "bg-warn" : state === "running" ? "bg-ok" : "bg-border",
        )}
      />
      {STATE_WORD[state]}
    </span>
  );
}

function Instance({ instance: i }: { instance: FreeLlmApiDoc["instance"] }) {
  if (i.state === "absent")
    return (
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">
        Nothing installed here yet. This clones the gateway at a commit it
        writes down, builds it, and runs it as a child of this API on{" "}
        <span className="font-mono">127.0.0.1:{i.port}</span> — loopback only,
        stopped when this API stops. It mints its own key, so nothing has to be
        pasted, and it needs no Docker.
      </p>
    );

  if (i.state === "installing")
    return (
      <p className="text-[12.5px]">
        {i.step ?? "working"}… A clone, its dependencies, two builds and the
        migration that mints the key. This takes minutes and keeps going if you
        leave the page.
      </p>
    );

  return (
    <div className="flex flex-col gap-1.5 text-[12.5px]">
      <Fact label="Commit">
        <span className="font-mono text-[11.5px]">{i.commit?.slice(0, 12)}</span>
        {i.installedAt && (
          <span className="text-muted-foreground">
            {" "}
            · installed {ago(i.installedAt)}
            {i.installSeconds !== null ? ` in ${i.installSeconds}s` : ""}
          </span>
        )}
      </Fact>
      <Fact label="Node">
        <span className="font-mono text-[11.5px]">{i.node?.version}</span>
      </Fact>
      {i.pid !== null && (
        <Fact label="Process">
          pid <span className="tabular-nums">{i.pid}</span> on{" "}
          <span className="font-mono text-[11.5px]">{i.url}</span>
          {i.healthyAt ? (
            <span className="text-muted-foreground"> · healthy {ago(i.healthyAt)}</span>
          ) : null}
          {i.restarts ? (
            <span className="text-warn"> · restarted {i.restarts}×</span>
          ) : null}
        </Fact>
      )}
      <Fact label="Key">
        {i.hasKey
          ? "minted by the gateway itself and sealed in the vault — it was never printed or shown"
          : "not minted yet; it arrives with the database the install creates"}
      </Fact>
      <Fact label="Comes back at boot">{i.autostart ? "yes" : "no"}</Fact>
      {/* The two facts that decide whether a fresh gateway can answer at all,
          and both are ordinary states rather than failures. */}
      <Fact label="Providers">
        {i.seeded
          ? "the two that need no key were switched on at the first start; add your own on its Keys page and they stay as you set them"
          : "none switched on yet — a gateway with no provider keys routes to nothing"}
      </Fact>
      {!i.dashboard && (
        <Fact label="Dashboard">
          <span className="text-warn">
            its web bundle did not build, so {i.dashboardUrl} will not render.
            The API is unaffected.
          </span>
        </Fact>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-muted-foreground w-[7.5rem] shrink-0 text-[11.5px]">
        {label}
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function AccountRow({
  account,
  automatic,
  busy,
  onUse,
}: {
  account: FreeLlmApiAccount;
  automatic: boolean;
  busy: boolean;
  onUse: () => void;
}) {
  return (
    <div
      className={cn(
        "bg-card rounded-[10px] border p-3",
        account.inUse && "border-ok/50",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium">{account.label}</span>
        <span className="text-muted-foreground font-mono text-[11px]">
          {account.baseUrl ?? "no endpoint stored"}
        </span>
        {account.inUse ? (
          <span className="text-ok ml-auto flex items-center gap-1.5 text-[11.5px]">
            <i className="bg-ok size-1.5 rounded-full" />
            {automatic ? "answering" : "answering · pinned"}
          </span>
        ) : (
          <Button
            variant="ghost"
            className="ml-auto h-7 px-2 text-[12px]"
            disabled={busy || !account.connected}
            onClick={onUse}
          >
            {busy ? "Switching…" : "Use this one"}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground mt-1.5 text-[11.5px]">
        {account.local ? "The instance on this machine" : "An instance somewhere else"}
        {account.lastOkAt ? ` · last answered ${ago(account.lastOkAt)}` : " · has not answered yet"}
      </p>
      {account.lastError && (
        <p className="text-destructive mt-1.5 text-[11.5px] leading-snug">
          {account.lastError}
        </p>
      )}
    </div>
  );
}
