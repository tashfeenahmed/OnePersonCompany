import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useApi } from "@/hooks/useApi";
import { api, type AgentId, type AgentReport, type AgentsDoc } from "@/lib/api";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * SPAWN HERE — the second way to connect an agent, under the first one.
 *
 * TWO PATHS ON ONE PAGE, AND THE ORDER IS THE ARGUMENT. Above this panel is
 * the form that has always been there: paste the address of an agent that is
 * already running somewhere and a bearer for it. That is the right answer when
 * there IS one — a Hermes on a Pi, a gateway on a work laptop — and nothing
 * here changes it. This is the answer when there is not, which is the ordinary
 * case: a form asking for the URL of a thing that does not exist is a dead end
 * dressed as a step.
 *
 * ONE COMPONENT FOR BOTH AGENTS, parameterised by id, because everything the
 * owner does here is the same on both sides — install, start, stop, make live,
 * see what it is pointed at — and the differences (a port, a version string, a
 * model name) are values the server already sends. Two components would be two
 * copies of the polling and the button states, and they would drift.
 *
 * IT POLLS WHILE SOMETHING IS HAPPENING AND NOT OTHERWISE. An install is
 * minutes of somebody else's output and a start is up to a minute of silence
 * followed by a health check; both need a live view. `installed`, `running`
 * and `stopped` are settled states that change only when this page presses a
 * button, so the timer stops. A dashboard that polls a finished thing forever
 * is a fan that never spins down.
 *
 * NO SECRET IS ON THIS PAGE AND NONE COULD BE. The provider's key and the
 * bearer this app generated for the agent's own door are written to files at
 * mode 0600 on the server; `AgentReport` has no field that could carry either,
 * so there is nothing here to accidentally render.
 */

const BUSY: AgentReport["state"][] = ["installing", "starting"];

const STATE_WORD: Record<AgentReport["state"], string> = {
  absent: "not installed",
  installing: "installing",
  installed: "installed, stopped",
  starting: "starting",
  running: "running",
  stopped: "stopped",
  failed: "failed",
};

export function AgentPanel({ id }: { id: AgentId }) {
  const doc = useApi(() => api.agents(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  const agent = doc.data?.agents.find((a) => a.id === id) ?? null;
  const active = agent !== null && BUSY.includes(agent.state);

  /*
    The poll. Two seconds while something is moving — an install prints a step
    a second and a start is worth watching — and nothing at all once it has
    settled. `doc.reload` is stable; `active` is what turns it on and off.
  */
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => doc.reload(), 2000);
    return () => clearInterval(timer);
  }, [active, doc]);

  if (doc.error || !doc.data || !agent) return null;

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setProblem(null);
    try {
      await fn();
    } catch (e: unknown) {
      /* The server's own sentence, verbatim. Every refusal it can give here —
         no model provider, the other agent is running, the port is taken — is
         written to be read by a person and names the thing to do next. */
      setProblem(e instanceof Error ? e.message : "That did not work, and nothing said why.");
    } finally {
      setBusy(null);
      doc.reload();
    }
  }

  return (
    <>
      <Separator className="mt-7 mb-5" />
      <div className="text-muted-foreground mb-3 text-[12px] tracking-[0.06em] uppercase">
        Or spawn one here
      </div>

      <p className="text-muted-foreground mb-4 text-[13.5px] leading-relaxed">
        This installs {agent.label} into the app's own data directory, points it
        at whichever model provider is the default, runs it as a child of this
        server, and connects the plugin to it — no URL and no key to paste. It
        binds to <span className="font-mono">127.0.0.1:{agent.port}</span> and
        it is stopped when this server stops.
      </p>

      <div className="bg-card rounded-[14px] p-4.5">
        <Head agent={agent} live={doc.data.live} />

        {/* What it is pointed at, which is the whole reason the model provider
            layer exists: one decision, inherited by whichever agent is up. */}
        <Pointed agent={agent} doc={doc.data} />

        {agent.step && (
          <p className="text-muted-foreground mt-2 text-[13px]">{agent.step}…</p>
        )}

        {agent.lastError && (
          <p
            className={cn(
              "mt-2 text-[13px] leading-snug",
              agent.state === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {agent.lastError}
          </p>
        )}

        <Facts agent={agent} />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {agent.state === "absent" || agent.state === "failed" ? (
            <Button
              className="h-8"
              disabled={busy !== null}
              onClick={() => void act("install", () => api.agentInstall(id))}
            >
              {agent.version ? "Reinstall" : "Install here"}
            </Button>
          ) : null}

          {agent.version && agent.state !== "running" && agent.state !== "starting" && (
            <Button
              className="h-8"
              disabled={busy !== null || !doc.data.provider}
              onClick={() => void act("start", () => api.agentStart(id))}
            >
              {busy === "start" ? "Starting…" : "Start"}
            </Button>
          )}

          {(agent.state === "running" || agent.state === "starting") && (
            <Button
              variant="outline"
              className="h-8"
              disabled={busy !== null}
              onClick={() => void act("stop", () => api.agentStop(id))}
            >
              {busy === "stop" ? "Stopping…" : "Stop"}
            </Button>
          )}

          {agent.state === "running" && !agent.live && (
            <Button
              variant="outline"
              className="h-8"
              disabled={busy !== null}
              onClick={() => void act("live", () => api.agentMakeLive(id))}
            >
              Make it the live agent
            </Button>
          )}

          {agent.state === "running" && (
            <Button
              variant="ghost"
              className="h-8"
              disabled={busy !== null}
              onClick={() => void act("reconfigure", () => api.agentReconfigure(id))}
            >
              {busy === "reconfigure" ? "Reconfiguring…" : "Re-point at the provider"}
            </Button>
          )}

          {agent.managedAccount !== null && (
            /* The two credentials this plugin can hold, and which one answers.
               Only offered once there IS a managed one — before that there is
               nothing to switch between and the button would be a puzzle. */
            <Button
              variant="ghost"
              className="h-8"
              disabled={busy !== null}
              onClick={() =>
                void act("mode", () =>
                  api.agentMode(id, agent.mode === "managed" ? "remote" : "managed"),
                )
              }
            >
              {agent.mode === "managed"
                ? "Use the pasted credentials instead"
                : "Use the instance here instead"}
            </Button>
          )}

          {agent.log.length > 0 && (
            <Button
              variant="ghost"
              className="text-muted-foreground ml-auto h-8"
              onClick={() => setShowLog((s) => !s)}
            >
              {showLog ? "Hide log" : "Log"}
            </Button>
          )}
        </div>

        {problem && (
          <p className="text-destructive mt-3 text-[13px] leading-snug">{problem}</p>
        )}

        {!doc.data.provider && doc.data.why && (
          <p className="text-warn mt-3 text-[13px] leading-snug">{doc.data.why}</p>
        )}

        {showLog && (
          /* The last lines of the install or the process, as it said them.
             Wrapped in its own scroller rather than allowed to grow the page:
             an installer prints a thousand lines and none of them should push
             the buttons off screen. */
          <pre className="bg-muted text-muted-foreground mt-3 max-h-64 overflow-auto rounded-[11px] p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">
            {agent.log.join("\n")}
          </pre>
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------- head */

function Head({ agent, live }: { agent: AgentReport; live: AgentId | null }) {
  const good = agent.state === "running";
  const bad = agent.state === "failed";
  const moving = agent.state === "installing" || agent.state === "starting";

  return (
    <div className="flex flex-wrap items-center gap-2 text-[14px]">
      <span className="font-medium">{agent.label} here</span>
      {agent.live ? (
        <span className="text-ok text-[12.5px]">live</span>
      ) : live !== null && agent.state === "running" ? (
        /* Running and not chosen is a real state and worth a word, because it
           is exactly the one somebody stares at wondering why their message
           went somewhere else. */
        <span className="text-muted-foreground text-[12.5px]">ready, not live</span>
      ) : null}
      <span
        className={cn(
          "ml-auto flex items-center gap-1.5 text-[12.5px]",
          bad ? "text-destructive" : moving ? "text-warn" : "text-muted-foreground",
        )}
      >
        <i
          className={cn(
            "size-1.5 rounded-full",
            good ? "bg-ok" : bad ? "bg-destructive" : moving ? "bg-warn" : "bg-border",
          )}
        />
        {STATE_WORD[agent.state]}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------- pointed */

function Pointed({ agent, doc }: { agent: AgentReport; doc: AgentsDoc }) {
  if (agent.pointed)
    return (
      <p className="mt-2 text-[13px] leading-relaxed">
        Thinking with{" "}
        <span className="font-medium">{agent.pointed.providerLabel}</span> ·{" "}
        <span className="font-mono">{agent.pointed.model}</span>{" "}
        <span className="text-muted-foreground">
          at {agent.pointed.endpointUrl} ({agent.pointed.endpoint})
          {agent.pointed.relay && " · through this box's relay, so the provider's policy queues its calls"}
        </span>
      </p>
    );

  if (doc.provider)
    return (
      <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
        Will be pointed at {doc.provider.label}
        {doc.provider.defaultModel ? ` · ${doc.provider.defaultModel}` : ""} when
        it starts.
      </p>
    );

  return null;
}

/* ------------------------------------------------------------------- facts */

/** Version, where, port, and the two counters worth seeing. A row of small
 *  facts rather than a table: none of them is worth a header. */
function Facts({ agent }: { agent: AgentReport }) {
  const bits: string[] = [];
  if (agent.version) bits.push(agent.version);
  if (agent.commit) bits.push(`commit ${agent.commit.slice(0, 12)}`);
  if (agent.installSeconds !== null) bits.push(`installed in ${agent.installSeconds}s`);
  if (agent.installedAt) bits.push(ago(agent.installedAt));
  if (agent.pid !== null) bits.push(`pid ${agent.pid}`);
  if (agent.healthyAt && agent.state === "running") bits.push(`up ${ago(agent.healthyAt)}`);
  if (agent.restarts) bits.push(`${agent.restarts} restart${agent.restarts === 1 ? "" : "s"}`);
  if (!bits.length) return null;

  return (
    <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
      {bits.join(" · ")}
      {agent.state === "running" && (
        <>
          {" · serves "}
          <span className="font-mono">{agent.url}</span>
          {" as "}
          <span className="font-mono">{agent.advertises}</span>
        </>
      )}
    </p>
  );
}
