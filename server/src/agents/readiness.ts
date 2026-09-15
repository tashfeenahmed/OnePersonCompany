import { setTimeout as delay } from "node:timers/promises";

export type ManagedState = {
  state: string;
  starting: boolean;
  hasChild: boolean;
  autostart: boolean;
  failedStarts: number;
  lastError: string | null;
};

/** A boot or crash restart may temporarily have no child. Wait for it, and
 * recover one failed start only when the owner still wants this agent running. */
export async function ensureManagedReady(options: {
  label: string;
  read: () => ManagedState;
  start: () => Promise<{ ok: boolean; error?: string }>;
  signal: AbortSignal;
  pollMs?: number;
}) {
  let attempted = false;
  for (;;) {
    options.signal.throwIfAborted();
    const s = options.read();
    if (s.hasChild && s.state === "running") return;
    if (s.hasChild && s.state === "failed") throw new Error(s.lastError ?? `${options.label} failed to start.`);
    if (!s.starting && !s.hasChild && s.state !== "starting") {
      if (!attempted && s.autostart && s.failedStarts < 5) {
        attempted = true;
        const result = await options.start();
        if (!result.ok) throw new Error(result.error ?? `${options.label} could not start.`);
        continue;
      }
      throw new Error(s.lastError ?? `${options.label} is not running. Start it under Integrations.`);
    }
    await delay(options.pollMs ?? 100, undefined, { signal: options.signal });
  }
}

/** An old gateway can still be releasing its port after the API restarts.
 * Wait briefly; a listener that remains is left alone. */
export async function waitForPortRelease(busy: () => Promise<boolean>, signal: AbortSignal, pollMs = 100) {
  try {
    for (;;) {
      signal.throwIfAborted();
      if (!await busy()) return true;
      await delay(pollMs, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) return false;
    throw error;
  }
}
