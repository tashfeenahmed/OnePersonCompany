import { useState } from "react";
import { Loader2, LogOut, ShieldAlert, ShieldCheck } from "lucide-react";
import { when } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Section } from "@/components/settings/Section";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { securityApi } from "@/lib/api/security";

/**
 * SETTINGS → SECURITY — the lock, and everything it is not.
 *
 * THE FIRST PARAGRAPH ON THIS TAB IS A DISCLAIMER AND THAT IS DELIBERATE. A
 * page with a password field on it reads as a security system; this is one
 * password with no accounts, no roles and no audit, and somebody who believed
 * otherwise would put this box somewhere it does not belong. So the panel says
 * what it is before it offers the field.
 *
 * THE AGENT IS THE FIRST THING ANYBODY WILL WORRY ABOUT, so it is answered
 * before it is asked: `opc`, the MCP servers and every loopback call carry a
 * service key from a file on this machine, and turning the lock on changes
 * nothing about them. The path is printed because the recovery story for a
 * forgotten password is that file.
 *
 * REMOVING THE PASSWORD ASKS FOR IT. Changing it asks for the old one. Neither
 * is friction for its own sake: a browser left open on a desk is one of the two
 * facts a change needs, and the password is the other.
 */
/* AN ABSENT DATE ON THIS PANEL MEANS IT NEVER HAPPENED. The password has
   never been changed; the session was never signed out. That is a fact about
   the box, not a figure nobody measured, so it is said in a word rather than
   drawn as the em dash `when` gives an unknown date everywhere else. */
const NEVER = { nullText: "never" } as const;

/** A user agent, shortened to the two words a person recognises. The full
 *  string is on the title attribute — it is what the server recorded and this
 *  panel does not get to decide it says something else. */
function browser(ua: string | null): string {
  if (!ua) return "a browser that sent no user agent";
  const name =
    /Firefox\/[\d.]+/.exec(ua)?.[0] ??
    /Edg\/[\d.]+/.exec(ua)?.[0] ??
    /Chrome\/[\d.]+/.exec(ua)?.[0] ??
    /Safari\/[\d.]+/.exec(ua)?.[0] ??
    ua.slice(0, 40);
  const os = /Mac OS X|Windows|Linux|iPhone|Android/.exec(ua)?.[0] ?? null;
  return os ? `${name} on ${os}` : name;
}

export function SecuritySettings() {
  const status = useApi(() => securityApi.status(), []);
  const [next, setNext] = useState("");
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const d = status.data;
  const enabled = d?.enabled ?? false;

  async function act(fn: () => Promise<{ note?: string }>) {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const res = await fn();
      setNote(res.note ?? "Done.");
      setNext("");
      setCurrent("");
      status.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section
        title="Password"
        hint="Require your password to open the workspace. Owner sign-in is required to approve email and change usage limits."
      >
        <div className="mb-3 flex items-center gap-2 text-[14px]">
          {enabled ? (
            <ShieldCheck className="size-4 text-ok" strokeWidth={1.8} />
          ) : (
            <ShieldAlert className="text-muted-foreground size-4" strokeWidth={1.8} />
          )}
          <span>
            {enabled
              ? `A password is set. Signed in with ${d?.how === "service-key" ? "the service key" : "a browser session"}.`
              : "No password is set. Set one to enable owner controls and protect the workspace."}
          </span>
          {enabled && d?.passwordChangedAt && (
            <span className="text-muted-foreground ml-auto text-[12.5px]">
              changed {when(d.passwordChangedAt, NEVER)}
            </span>
          )}
        </div>

        <div className="grid max-w-[420px] gap-3">
          {enabled && (
            <div className="grid gap-1.5">
              <Label htmlFor="sec-current">Current password</Label>
              <Input
                id="sec-current"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="sec-next">{enabled ? "New password" : "Password"}</Label>
            <Input
              id="sec-next"
              type="password"
              autoComplete="new-password"
              placeholder="Ten characters at least"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || next.length < 10 || (enabled && !current)}
              onClick={() => void act(() => securityApi.setPassword(next, current))}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />}
              {enabled ? "Change password" : "Set password"}
            </Button>
            {enabled && (
              <Button
                variant="outline"
                disabled={busy || !current}
                onClick={() => void act(() => securityApi.removePassword(current))}
              >
                Remove the password
              </Button>
            )}
          </div>
          {problem && <p role="alert" className="text-destructive text-[13.5px]">{problem}</p>}
          {note && <p className="text-[13.5px]">{note}</p>}
        </div>
        <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">How access works</summary><p className="mt-2">This is a single-owner workspace. Browser sessions expire after 30 days, or 7 days without activity. The service key lets local integrations use the API; it cannot approve or send email. Software running as the same operating-system user still has access to local files.</p></details>
      </Section>

      <Section
        title="The agent keeps working"
        hint="Every in-process caller on this box — the `opc` command, the MCP servers, the skills proxy, a run assembling its brief — sends a service key instead of a cookie, so turning the lock on does not blind the chief of staff."
      >
        <p className="text-muted-foreground text-[13.5px] leading-relaxed">
          The key is{" "}
          <span className="text-foreground font-mono">
            {d?.serviceKeyFile ?? "server/data/service-key"}
          </span>
          , mode 0600. Anything that can read it has the whole API — the same thing that is already
          true of <span className="font-mono">vault.key</span> beside it, which decrypts every
          credential here. Replacing the file rotates the key: the `opc` wrapper reads it on every
          invocation. It is also the way back in if this password is forgotten.
        </p>
      </Section>

      <Section
        title="Sessions"
        hint="One row per browser that signed in. Revoking one signs that browser out at its next request; changing the password revokes all of them."
      >
        {!enabled ? (
          <p className="text-muted-foreground text-[13.5px]">
            There is no password, so there are no sessions.
          </p>
        ) : !d?.sessions?.length ? (
          <p className="text-muted-foreground text-[13.5px]">No browser has signed in yet.</p>
        ) : (
          <div className="overflow-hidden rounded-[14px] bg-card">
            {d.sessions.map((s, i) => (
              <div
                key={s.id}
                className={cn(
                  "flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-3.5 py-2.5 text-[13.5px]",
                  i > 0 && "border-line-soft border-t",
                  s.revokedAt && "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
                    s.revokedAt ? "bg-border" : "bg-ok",
                  )}
                />
                <span title={s.userAgent ?? undefined}>{browser(s.userAgent)}</span>
                {s.current && !s.revokedAt && (
                  <span className="text-muted-foreground text-[12.5px]">this browser</span>
                )}
                <span className="text-muted-foreground ml-auto text-[12.5px]">
                  {s.revokedAt ? `signed out ${when(s.revokedAt, NEVER)}` : `last used ${when(s.lastSeenAt, NEVER)}`}
                </span>
                {!s.revokedAt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const r = await securityApi.revoke(s.id);
                        if (r.wasCurrent) window.location.replace("/login");
                        return { note: "Session revoked." };
                      })
                    }
                  >
                    <LogOut className="size-3.5" strokeWidth={1.8} />
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
