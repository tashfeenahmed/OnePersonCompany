import { useEffect, useState } from "react";
import { Check, Download, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useApi } from "@/hooks/useApi";
import { api, type SearxngInstance } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * THE TWO WAYS TO HAVE A SEARCH NODE, SIDE BY SIDE, because they are a choice
 * and not a fallback.
 *
 * Every other integration on this page has one door: paste a credential for
 * somebody else's service. SearXNG has two, and until this panel existed only
 * the harder one was visible — the owner had to already run an instance
 * somewhere, put a proxy in front of it, invent a key and paste a hostname
 * carrying an IP address. The other door is one button: the server clones
 * SearXNG, builds it under `data/searxng/` and runs it on 127.0.0.1:8888.
 *
 * SO THE PANEL IS TWO COLUMNS AND NOT A WIZARD. Neither path is the "advanced"
 * one — a node the owner already runs is the right answer for a box that
 * should not be compiling anything, and a local install is the right answer
 * for a laptop that has nothing yet — and a flow that led with one would be
 * making that decision on their behalf.
 *
 * WHAT THE RIGHT-HAND COLUMN HAS TO SAY, and why each part is here:
 *
 *   — the STATE, in a word, with the sentence that word cannot carry.
 *     `installed` and `stopped` look the same on disk and mean different
 *     things about what has happened.
 *   — the STEP and the LOG TAIL while installing, because a four-minute wait
 *     with a spinner over it is indistinguishable from a hang, and the log is
 *     what says whether it is cloning, compiling or stuck.
 *   — the COMMIT, because "SearXNG" is not a version and the day this stops
 *     working the only useful question is which one is on disk.
 *   — whether it is IN USE, which is not the same as running: the endpoint
 *     setting can point at the remote node while this one is up, and a panel
 *     that implied otherwise would be lying about where the searches go.
 *
 * IT POLLS ONLY WHILE SOMETHING IS MOVING. An installing or starting instance
 * changes on its own; an installed one does not, and a page that re-fetched
 * every two seconds forever would be spending the machine to redraw the same
 * word.
 */
export function SearxngPanel({
  endpoint,
  onChanged,
}: {
  /** The configured search endpoint, as the settings form holds it. Passed in
   *  rather than fetched again: the page has already asked for it. */
  endpoint: string | null;
  /** Connecting the plugin happens on the server, on the first healthy run —
   *  so the page above has to re-read itself when this changes. */
  onChanged: () => void;
}) {
  const report = useApi(() => api.searxngInstance(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const state = report.data?.state ?? null;
  const moving = state === "installing" || state === "starting";
  /** True once the instance has come up and the plugin has been pointed at it
   *  — the reason the page above needs re-reading. */
  const running = state === "running";

  /* `reload` and not `report`: the hook hands back a new object every render,
     and depending on it would tear down and re-arm this interval on every
     redraw — which for a poll that only fires between redraws is a poll that
     mostly does not. */
  const reload = report.reload;
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => reload(), 2000);
    return () => clearInterval(timer);
  }, [moving, reload]);

  /* The plugin is connected by the SERVER, on the first healthy run, so the
     page cannot know it happened by having asked for it. This re-reads the
     rows above the moment the instance reports itself up. */
  useEffect(() => {
    if (running) onChanged();
    // onChanged is a fresh closure each render; the transition is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  if (report.error || !report.data) return null;
  const inst = report.data;

  async function act(what: string, fn: () => Promise<SearxngInstance>) {
    setBusy(what);
    setProblem(null);
    try {
      report.setData(await fn());
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      report.reload();
    }
  }

  const remote = !!endpoint && !/^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)[:/]/i.test(endpoint);

  return (
    <>
      <Separator className="mt-7 mb-5" />
      <div className="text-muted-foreground mb-3 text-[11px] tracking-[0.06em] uppercase">
        Where the searches go
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* ---------------------------------------------------- the remote node */}
        <div
          className={cn(
            "bg-card rounded-[10px] border p-3.5",
            remote && !inst.inUse && "border-line-strong",
          )}
        >
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium">Add a URL and a key</span>
            {!inst.inUse && remote && (
              <Badge variant="secondary" className="bg-ok-bg text-ok border-transparent">
                In use
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-2 text-[12px] leading-relaxed">
            A node you already run. Put its address in the search endpoint
            setting below and its API key in the credentials above — the key
            travels as an <span className="font-mono">x-api-key</span> header,
            because that is what the proxy in front of a public instance
            expects.
          </p>
          {endpoint && (
            <p className="text-muted-foreground mt-2 font-mono text-[11px] break-all">
              {endpoint}
            </p>
          )}
        </div>

        {/* --------------------------------------------------- the local one */}
        <div
          className={cn(
            "bg-card rounded-[10px] border p-3.5",
            inst.inUse && "border-line-strong",
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">Install here</span>
            <StateBadge inst={inst} />
            {inst.inUse && inst.state === "running" && (
              <Badge variant="secondary" className="bg-ok-bg text-ok border-transparent">
                In use
              </Badge>
            )}
          </div>

          <p className="text-muted-foreground mt-2 text-[12px] leading-relaxed">
            {SENTENCE[inst.state]}
          </p>

          {/* The address it serves, which is also the whole of its access
              control: nothing off this machine can open a loopback port, so
              there is no key to invent and none to paste. */}
          <p className="text-muted-foreground mt-2 font-mono text-[11px]">
            {inst.url}
          </p>

          {inst.state === "running" && inst.inUse && (
            <p className="text-ok mt-2 flex items-center gap-1.5 text-[12px]">
              <Check className="size-3.5" strokeWidth={2} />
              Connected automatically — no key, because it is loopback
            </p>
          )}
          {inst.state === "running" && !inst.inUse && (
            <p className="text-muted-foreground mt-2 text-[12px]">
              Running, but the searches still go to the endpoint above. Set the
              search endpoint to {inst.url} to use this one.
            </p>
          )}

          {/* WHAT IS ON DISK. The commit is the version — SearXNG publishes no
              release this could name instead — and the Python is here because
              it is the dependency that decides whether the build works at all. */}
          {inst.commit && (
            <div className="text-muted-foreground mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
              <span className="font-mono">{inst.commit.slice(0, 12)}</span>
              {inst.python && <span>python {inst.python.version}</span>}
              {inst.installSeconds !== null && (
                <span>installed in {inst.installSeconds}s</span>
              )}
              {inst.pid !== null && <span>pid {inst.pid}</span>}
              {!!inst.restarts && (
                <span>
                  {inst.restarts} restart{inst.restarts === 1 ? "" : "s"}
                </span>
              )}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {inst.state === "absent" && (
              <Button
                size="sm"
                disabled={!!busy}
                onClick={() => void act("install", () => api.searxngInstall())}
              >
                <Download className="size-3.5" strokeWidth={1.8} />
                {busy === "install" ? "Starting…" : "Install here"}
              </Button>
            )}
            {(inst.state === "installed" ||
              inst.state === "stopped" ||
              inst.state === "failed") && (
              <Button
                size="sm"
                /* A failed INSTALL has nothing to start, and the difference is
                   the marker on disk rather than the state word — `failed`
                   covers both "the build broke" and "the process would not
                   come up", and only the second of those has a commit. */
                disabled={!!busy || !inst.commit}
                onClick={() => void act("start", () => api.searxngStart())}
              >
                <Play className="size-3.5" strokeWidth={1.8} />
                {busy === "start" ? "Starting…" : "Start"}
              </Button>
            )}
            {(inst.state === "running" || inst.state === "starting") && (
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() => void act("stop", () => api.searxngStop())}
              >
                <Square className="size-3.5" strokeWidth={1.8} />
                {busy === "stop" ? "Stopping…" : "Stop"}
              </Button>
            )}
            {inst.autostart && inst.state !== "running" && (
              <span className="text-muted-foreground text-[11.5px]">
                set to come back when the API restarts
              </span>
            )}
          </div>

          {/* THE STEP AND THE LOG, while it is installing. A clone, a
              virtualenv and three compiled dependencies are minutes of nothing
              visible happening, and a spinner with no words under it is
              indistinguishable from a hang. */}
          {(moving || inst.state === "failed") && (
            <div className="mt-3">
              {inst.step && (
                <div className="text-[12px]">
                  <span className="font-medium">{inst.step}</span>
                </div>
              )}
              {inst.lastError && (
                <p className="text-destructive mt-1 text-[11.5px] leading-snug">
                  {inst.lastError}
                </p>
              )}
              {!!inst.log.length && (
                <pre className="bg-muted/40 text-muted-foreground mt-2 max-h-40 overflow-auto rounded-[8px] p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap">
                  {inst.log.slice(-12).join("\n")}
                </pre>
              )}
            </div>
          )}

          {problem && (
            <p className="text-destructive mt-2 text-[12px]">{problem}</p>
          )}
        </div>
      </div>

      <p className="text-muted-foreground mt-3 text-[11.5px]">
        The local instance is a child of the API process: it stops when the API
        stops, comes back if it was running when the API last did, and is
        restarted if it crashes. It is installed into{" "}
        <span className="font-mono">{inst.dir}</span> and binds to 127.0.0.1
        only.
      </p>
    </>
  );
}

/** One word per state, and the badge's colour is the only opinion it has:
 *  amber for something in flight, red for a failure, green for running. */
function StateBadge({ inst }: { inst: SearxngInstance }) {
  const tone =
    inst.state === "running"
      ? "bg-ok-bg text-ok border-transparent"
      : inst.state === "failed"
        ? "text-destructive border-transparent"
        : undefined;
  return (
    <Badge variant="secondary" className={cn(tone)}>
      {WORD[inst.state]}
    </Badge>
  );
}

const WORD: Record<SearxngInstance["state"], string> = {
  absent: "not installed",
  installing: "installing",
  installed: "installed",
  starting: "starting",
  running: "running",
  stopped: "stopped",
  failed: "failed",
};

/**
 * The sentence each state deserves, because the word cannot carry it.
 *
 * `installed` and `stopped` are the same directory on disk and are kept apart
 * anyway: one has never run and one has been asked to stop, and telling an
 * owner their fresh install is "stopped" would invite them to go looking for
 * what stopped it.
 */
const SENTENCE: Record<SearxngInstance["state"], string> = {
  absent:
    "Nothing installed yet. This clones SearXNG, builds it into its own virtualenv with uv and runs it on this machine — a few minutes, and no Docker needed.",
  installing:
    "Cloning and building. The compiled dependencies (lxml, msgspec, curl_cffi) are the slow part; the log below is what is actually happening.",
  installed:
    "Installed and not running. Start it and the plugin connects itself — there is no key to paste, because a loopback bind is the whole of the access control.",
  starting:
    "Started, waiting for it to answer /healthz. A first boot loads every engine definition, so it is a second or two behind the process existing.",
  running:
    "Running as a child of the API, bound to loopback. It stops when the API stops and comes back with it.",
  stopped:
    "Stopped. Nothing is listening on the port and it will not come back on its own at the next API restart.",
  failed:
    "It did not come up. The reason is below — the usual ones are a port already taken and a dependency that would not build.",
};
