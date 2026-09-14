import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
const Onboarding = lazy(() =>
  import("@/pages/Onboarding").then((m) => ({ default: m.Onboarding })),
);
const Login = lazy(() =>
  import("@/areas/security/Login").then((m) => ({ default: m.Login })),
);
type Status = {
  needed: boolean;
  started: boolean;
  completed: boolean;
  authenticated: boolean;
};
async function readStatus(): Promise<Status> {
  const res = await fetch("/api/onboarding/status");
  if (!res.ok) throw Error("The server is not available.");
  return (await res.json()) as Status;
}
/** Resolve first-run state before mounting the workspace store, which otherwise saves starter boards. */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState("");
  async function load() {
    try {
      const data = await readStatus();
      setStatus(data);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    let active = true;
    void readStatus()
      .then((data) => {
        if (active) setStatus(data);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const loading = (
    <div className="flex h-dvh items-center justify-center gap-3 bg-background text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Opening your workspace…
    </div>
  );
  if (error)
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4">
        <p>{error}</p>
        <button
          className="rounded-lg border px-4 py-2"
          onClick={() => void load()}
        >
          Try again
        </button>
      </div>
    );
  if (!status) return loading;
  if (!status.authenticated)
    return (
      <Suspense fallback={loading}>
        <div className="flex h-dvh flex-col">
          <Login />
        </div>
      </Suspense>
    );
  if (status.needed) {
    return (
      <Suspense fallback={loading}>
        <Onboarding />
      </Suspense>
    );
  }
  // Existing workspaces bypass onboarding entirely, including after a schema upgrade.
  if (window.location.pathname === "/onboarding")
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4">
        <h1 className="text-2xl">Your workspace is already set up.</h1>
        <a
          className="rounded-lg bg-foreground px-5 py-3 text-background"
          href="/dashboards/overview"
        >
          Open workspace
        </a>
      </div>
    );
  return children;
}
