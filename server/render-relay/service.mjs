import { credentialed } from "../src/accounts.ts";
import * as engine from "./engine/reel.js";
import { startQueue } from "./engine/queue.js";
import { createRelayServer } from "./http.mjs";

const port = Number(process.env.OPC_RENDER_RELAY_PORT || 3014);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid render relay port");
// Keep the existing integration ID so older databases retain their credentials.
const configured = credentialed("workdash", ["url", "key"], "render_relay").ready;
const selected = configured.filter(({ values }) => {
  try { const url = new URL(values.url); return url.hostname === "127.0.0.1" && Number(url.port) === port; }
  catch { return false; }
});
if (selected.length !== 1) throw new Error("Connect exactly one OPC render relay account at this loopback port.");
const server = createRelayServer({ engine, key: selected[0].values.key });
server.listen(port, "127.0.0.1", () => {
  startQueue();
  console.log(`OPC render relay listening on 127.0.0.1:${port}`);
});
// Never interrupt an active render for a routine service stop.
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  server.close();
  const drain = setInterval(() => {
    if (!engine.reelRunning()) { clearInterval(drain); process.exit(0); }
  }, 1000);
});
