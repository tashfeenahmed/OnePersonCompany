import { useEffect, useState } from "react";
import { Lock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApi } from "@/hooks/useApi";
import { securityApi } from "@/lib/api/security";

/**
 * THE LOGIN PAGE — the only screen in this app that exists because something
 * was refused.
 *
 * IT ASKS THE SERVER WHETHER THERE IS A LOCK AT ALL before it draws a form,
 * and that is the whole reason `/api/security/status` is open to an
 * unauthenticated caller. Three states, and each of them is a different
 * sentence: there is no password on this box (so this page has nothing to do
 * and says how to set one), there is one and you are not signed in (the form),
 * or there is one and you already are (which happens when somebody bookmarks
 * this address).
 *
 * WHERE IT GOES AFTERWARDS is `?next=`, which lib/api.ts puts there when it
 * redirects — so being signed out in the middle of the board sends you back to
 * the board rather than to the top of the app. It is a PATH and is checked to
 * start with a single slash: a `next` somebody could set to another origin is
 * an open redirect, which is a real vulnerability on a real login page and
 * costs one line to refuse.
 *
 * A FULL PAGE LOAD RATHER THAN A ROUTER NAVIGATION on success, deliberately.
 * Every page in this app fetched its data before the cookie existed and is
 * holding an error; navigating in place would leave a screen of "the API is not
 * running" behind a session that is now perfectly good.
 */
function safeNext(): string {
  const raw = new URLSearchParams(window.location.search).get("next") ?? "/";
  return /^\/(?!\/)/.test(raw) ? raw : "/";
}

export function Login() {
  const status = useApi(() => securityApi.status(), []);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /* Already signed in and standing on the login page: go where you were
     going. In an effect rather than during render, because a redirect is a
     side effect and React is entitled to render this twice. */
  useEffect(() => {
    if (status.data?.enabled && status.data.authenticated) window.location.replace(safeNext());
  }, [status.data]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await securityApi.login(password);
      window.location.replace(safeNext());
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const d = status.data;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="w-full max-w-[360px]">
        <div className="mb-5 flex items-center gap-2.5">
          <Lock className="size-4" strokeWidth={1.8} />
          <h1 className="text-[20px] font-normal tracking-[-0.02em]">
            {d && !d.enabled ? "This dashboard has no password" : "Sign in"}
          </h1>
        </div>

        {status.error && (
          <p className="text-muted-foreground text-[14px] leading-relaxed">
            The API is not answering ({status.error}), so there is nothing to sign in to yet.
          </p>
        )}

        {d && !d.enabled && (
          <p className="text-muted-foreground text-[14px] leading-relaxed">
            /api is open to anything that can reach the port, which is the state this box ships in
            and is fine while it is on loopback. Set a password in Settings → Security if it is ever
            going to be reachable from anywhere else.
          </p>
        )}

        {d?.enabled && !d.authenticated && (
          <form onSubmit={(e) => void submit(e)} className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="pw">Password</Label>
              <Input
                id="pw"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy || !password}>
              {busy && <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />}
              {busy ? "Checking…" : "Sign in"}
            </Button>
            {problem && <p className="text-destructive text-[13.5px]">{problem}</p>}
            <p className="text-muted-foreground text-[12.5px] leading-relaxed">
              One password, one owner — this is a lock on a door, not a user system. If it has been
              forgotten, the service key in <span className="font-mono">server/data/service-key</span> on
              this machine still opens the API, and the password can be removed from a shell.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
