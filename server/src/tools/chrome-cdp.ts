import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The port Chrome chose, out of the file it writes into its own profile. Not
 *  a fixed port: two of these must be able to run at once, and a fixed one is
 *  a collision waiting for the day somebody presses two buttons. */
export async function waitForPort(profile: string, deadline: number, failed?: () => boolean): Promise<number | null> {
  const file = resolve(profile, "DevToolsActivePort");
  while (Date.now() < deadline) {
    /* A browser that never started will never write the file, and waiting
       fifteen seconds to be told so is fifteen seconds of a request hanging. */
    if (failed?.()) return null;
    if (existsSync(file)) {
      try {
        const first = readFileSync(file, "utf8").split("\n")[0]?.trim();
        const port = Number(first);
        if (Number.isInteger(port) && port > 0) return port;
      } catch {
        /* Written between the exists check and the read. Try again. */
      }
    }
    await sleep(120);
  }
  return null;
}

/** A minimal DevTools client: send a command, await its id. Four messages is
 *  the whole conversation, so this is a Map of pending resolvers and nothing
 *  more — an event router would be machinery bought with nothing. */
export type Cdp = {
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>;
  close: () => void;
};

export async function connect(wsUrl: string, deadline: number): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  const pending = new Map<number, { ok: (v: Record<string, unknown>) => void; no: (e: Error) => void }>();
  let id = 0;

  /* THE SOCKET IS CLOSED ON EVERY PATH OUT OF THE OPEN, including the two that
     throw. It was harmless before only because the browser is killed a moment
     later, and "harmless because something else cleans up" is how a handle
     leak survives until the day that something else changes. */
  const rejectPending = () => {
    for (const waiter of pending.values()) waiter.no(new Error("The browser connection closed."));
    pending.clear();
  };
  ws.addEventListener("close", rejectPending);
  const closeSocket = () => {
    rejectPending();
    try {
      ws.close();
    } catch {
      /* Already gone. */
    }
  };
  await new Promise<void>((ok, no) => {
    const timer = setTimeout(() => {
      closeSocket();
      no(new Error("the browser's DevTools socket did not open in time"));
    }, Math.max(1, deadline - Date.now()));
    ws.addEventListener("open", () => { clearTimeout(timer); ok(); }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      closeSocket();
      no(new Error("the browser's DevTools socket refused the connection"));
    }, { once: true });
  });

  ws.addEventListener("message", (ev) => {
    let doc: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      doc = JSON.parse(String((ev as MessageEvent).data)) as typeof doc;
    } catch {
      return;
    }
    if (typeof doc.id !== "number") return; // an event, which nothing here waits on
    const waiter = pending.get(doc.id);
    if (!waiter) return;
    pending.delete(doc.id);
    if (doc.error) waiter.no(new Error(doc.error.message ?? "the browser refused that command"));
    else waiter.ok(doc.result ?? {});
  });

  return {
    send(method, params = {}, sessionId) {
      const messageId = ++id;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        /* Every command carries the RUN's deadline rather than one of its own:
           a page that hangs must not be able to buy another twenty-five
           seconds per message. */
        const timer = setTimeout(() => {
          if (pending.delete(messageId)) reject(new Error(`${method} did not answer in time`));
        }, Math.max(1, deadline - Date.now()));
        pending.set(messageId, {
          ok: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          no: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        try {
          ws.send(JSON.stringify(sessionId ? { id: messageId, method, params, sessionId } : { id: messageId, method, params }));
        } catch (error) {
          pending.delete(messageId);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    close: closeSocket,
  };
}

